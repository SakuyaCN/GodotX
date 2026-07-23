import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  normalizeAnthropicBaseUrl,
} from "../src/provider/anthropic.js";
import { ProviderHttpError } from "../src/provider/errors.js";
import type { ModelProvider, ProviderRequest, ProviderStreamEvent } from "../src/provider/types.js";

test("Anthropic normalizes API roots and requires explicit consent for remote HTTP", () => {
  assert.equal(normalizeAnthropicBaseUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1");
  assert.equal(normalizeAnthropicBaseUrl("https://proxy.example/v1/"), "https://proxy.example/v1");
  assert.equal(
    normalizeAnthropicBaseUrl("http://203.0.113.10:8990", true),
    "http://203.0.113.10:8990/v1",
  );
  assert.throws(
    () => normalizeAnthropicBaseUrl("http://203.0.113.10:8990"),
    /insecure HTTP is explicitly enabled/u,
  );
  assert.throws(() => normalizeAnthropicBaseUrl("https://user:pass@example.com"), /credentials/u);
  assert.throws(() => normalizeAnthropicBaseUrl("https://example.com?v=1"), /query or fragment/u);
});

test("Anthropic lists paginated models with native authentication and capabilities", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const provider = new AnthropicProvider({
    baseUrl: "https://anthropic.example",
    apiKey: "anthropic-test-secret",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return Response.json({
          data: [{ id: "claude-sonnet", display_name: "Claude Sonnet", type: "model" }],
          has_more: true,
          last_id: "claude-sonnet",
        });
      }
      return Response.json({
        data: [{ id: "claude-opus", display_name: "Claude Opus", type: "model" }],
        has_more: false,
      });
    },
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), ["claude-opus", "claude-sonnet"]);
  assert.equal(models[1]?.displayName, "Claude Sonnet");
  assert.equal(models[0]?.ownedBy, "anthropic");
  assert.deepEqual(models[0]?.capabilities?.image_input, {
    status: "supported",
    mime_types: ["image/png", "image/jpeg", "image/webp"],
    detail_levels: ["low", "high"],
    max_images: 4,
  });
  assert.deepEqual(requests.map((entry) => entry.url), [
    "https://anthropic.example/v1/models",
    "https://anthropic.example/v1/models?after_id=claude-sonnet",
  ]);
  assert.equal(requests[0]?.headers.get("x-api-key"), "anthropic-test-secret");
  assert.equal(requests[0]?.headers.get("anthropic-version"), ANTHROPIC_VERSION);
  assert.equal(requests[0]?.headers.has("authorization"), false);
  const imageProvider = provider as ModelProvider;
  assert.equal(imageProvider.generateImage, undefined);
  assert.equal(imageProvider.editImage, undefined);
});

test("Anthropic streams thinking, text, tools, images, usage, and tool results", async () => {
  let requestBody: Record<string, unknown> = {};
  let requestHeaders = new Headers();
  let attachmentReads = 0;
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspect"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" first."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" now."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_new","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"demo/main.gd\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":20,"output_tokens":8},"delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const provider = new AnthropicProvider({
    baseUrl: "https://anthropic.example/v1",
    apiKey: "anthropic-test-secret",
    fetchImpl: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const events: ProviderStreamEvent[] = [];
  const request: ProviderRequest = {
    model: "claude-sonnet",
    systemPrompt: "You are GodotX.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image" },
          {
            type: "image",
            attachmentId: "a".repeat(64),
            mimeType: "image/png",
            detail: "high",
          },
        ],
      },
      {
        role: "assistant",
        content: "Earlier",
        toolCalls: [{ id: "call_old", name: "read_file", arguments: '{"path":"demo/old.gd"}' }],
        reasoningContent: "Provider-private reasoning must not be replayed as unsigned thinking.",
      },
      { role: "tool", callId: "call_old", name: "read_file", content: "extends Node" },
      { role: "user", content: "Continue" },
    ],
    tools: [{
      name: "read_file",
      description: "Read one project file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
    resolveAttachment: async (attachmentId) => {
      attachmentReads += 1;
      return {
        id: attachmentId,
        mimeType: "image/png",
        bytes: Uint8Array.of(1, 2, 3),
        width: 1,
        height: 1,
        byteSize: 3,
      };
    },
    onEvent: (event) => events.push(event),
  };

  const result = await provider.streamTurn(request);
  assert.equal(attachmentReads, 1);
  assert.equal(requestHeaders.get("x-api-key"), "anthropic-test-secret");
  assert.equal(requestHeaders.get("accept"), "text/event-stream");
  assert.equal(requestBody.system, "You are GodotX.");
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.max_tokens, 16_384);
  assert.deepEqual(requestBody.tools, [{
    name: "read_file",
    description: "Read one project file",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }]);
  const messages = requestBody.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0]?.content[0], { type: "text", text: "Inspect this image" });
  assert.deepEqual(messages[0]?.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AQID" },
  });
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Earlier" },
      { type: "tool_use", id: "call_old", name: "read_file", input: { path: "demo/old.gd" } },
    ],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_old", content: "extends Node" },
      { type: "text", text: "Continue" },
    ],
  });
  assert.deepEqual(result, {
    message: {
      role: "assistant",
      content: "Done now.",
      toolCalls: [{ id: "call_new", name: "read_file", arguments: '{"path":"demo/main.gd"}' }],
      reasoningContent: "Inspect first.",
    },
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
  assert.equal(
    events.filter((event) => event.type === "text_delta").map((event) => (
      event.type === "text_delta" ? event.text : ""
    )).join(""),
    "Done now.",
  );
  assert.equal(
    events.filter((event) => event.type === "reasoning_delta").map((event) => (
      event.type === "reasoning_delta" ? event.text : ""
    )).join(""),
    "Inspect first.",
  );
});

test("Anthropic classifies authentication failures without leaking the API key", async () => {
  const secret = "anthropic-super-secret";
  const provider = new AnthropicProvider({
    baseUrl: "https://anthropic.example",
    apiKey: secret,
    fetchImpl: async () => new Response(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: `Invalid key ${secret}` },
    }), { status: 401 }),
  });

  await assert.rejects(() => provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 401);
    assert.equal(error.category, "authentication");
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });
});

test("Anthropic classifies native billing errors", async () => {
  const provider = new AnthropicProvider({
    baseUrl: "https://anthropic.example",
    apiKey: "anthropic-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      type: "error",
      error: { type: "billing_error", message: "Credit balance is too low" },
    }), { status: 400 }),
  });

  await assert.rejects(() => provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 400);
    assert.equal(error.category, "billing");
    return true;
  });
});
