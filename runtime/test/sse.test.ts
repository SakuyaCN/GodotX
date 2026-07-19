import assert from "node:assert/strict";
import test from "node:test";
import { decodeSse } from "../src/sse.js";

test("SSE decoder handles byte, JSON, CRLF, and Unicode boundaries", async () => {
  const source = [
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"H"}\r\n\r\n',
    'data: {"type":"response.output_text.delta","delta":"你"}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const bytes = new TextEncoder().encode(source);
  const splitPoints = [1, 7, 19, 43, 82, 121, 122, bytes.length - 3, bytes.length];
  let start = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const end of splitPoints) {
        if (end > start) controller.enqueue(bytes.slice(start, end));
        start = end;
      }
      controller.close();
    },
  });

  const messages = [];
  for await (const message of decodeSse(stream)) messages.push(message);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.event, "response.output_text.delta");
  assert.equal(JSON.parse(messages[0]!.data).delta, "H");
  assert.equal(JSON.parse(messages[1]!.data).delta, "你");
  assert.equal(messages[2]?.data, "[DONE]");
});

test("SSE decoder combines multiple data fields", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\ndata: second\n\n"));
      controller.close();
    },
  });
  const messages = [];
  for await (const message of decodeSse(stream)) messages.push(message);
  assert.equal(messages[0]?.data, "first\nsecond");
});
