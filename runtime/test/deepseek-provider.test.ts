import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekProvider,
} from "../src/provider/deepseek.js";
import type { ModelProvider, ProviderRequest } from "../src/provider/types.js";

const UNSUPPORTED_IMAGE_INPUT = {
  status: "unsupported",
  mime_types: [],
  detail_levels: [],
  max_images: 0,
};

test("DeepSeek lists models from the fixed official endpoint with V4 capabilities", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new DeepSeekProvider({
    apiKey: "test-deepseek-key",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json({
        object: "list",
        data: [
          { id: "deepseek-v4-pro", owned_by: "deepseek" },
          { id: "deepseek-chat", owned_by: "deepseek" },
          { id: "deepseek-v4-flash", owned_by: "deepseek" },
        ],
      });
    },
  });

  assert.equal(DEEPSEEK_BASE_URL, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-v4-flash");
  assert.deepEqual(await provider.listModels(), [
    {
      id: "deepseek-chat",
      ownedBy: "deepseek",
      capabilities: { image_input: UNSUPPORTED_IMAGE_INPUT },
    },
    {
      id: "deepseek-v4-flash",
      ownedBy: "deepseek",
      capabilities: {
        reasoning: { efforts: ["high", "max"], default_effort: "high" },
        image_input: UNSUPPORTED_IMAGE_INPUT,
      },
    },
    {
      id: "deepseek-v4-pro",
      ownedBy: "deepseek",
      capabilities: {
        reasoning: { efforts: ["high", "max"], default_effort: "high" },
        image_input: UNSUPPORTED_IMAGE_INPUT,
      },
    },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.deepseek.com/models");
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), "Bearer test-deepseek-key");
});

test("DeepSeek exposes no image generation surface and rejects image input before HTTP", async () => {
  let requestCount = 0;
  const provider = new DeepSeekProvider({
    apiKey: "test-deepseek-key",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("data: [DONE]\n\n");
    },
  });
  const imageProvider = provider as ModelProvider;

  assert.equal(imageProvider.getImageGenerationCapabilities, undefined);
  assert.equal(imageProvider.listImageModels, undefined);
  assert.equal(imageProvider.listImageEditModels, undefined);
  assert.equal(imageProvider.generateImage, undefined);
  assert.equal(imageProvider.editImage, undefined);
  assert.deepEqual(provider.getModelCapabilities(DEEPSEEK_DEFAULT_MODEL).image_input, UNSUPPORTED_IMAGE_INPUT);

  assert.throws(
    () => provider.streamTurn({
      model: DEEPSEEK_DEFAULT_MODEL,
      systemPrompt: "test",
      messages: [{
        role: "user",
        content: [{
          type: "image",
          attachmentId: "a".repeat(64),
          mimeType: "image/png",
          detail: "high",
        }],
      }],
      tools: [],
      resolveAttachment: async () => ({
        id: "a".repeat(64),
        mimeType: "image/png",
        bytes: Uint8Array.of(1),
        width: 1,
        height: 1,
        byteSize: 1,
      }),
      onEvent: () => undefined,
    }),
    /does not support image input/u,
  );
  assert.equal(requestCount, 0);
});

test("DeepSeek V4 sends thinking controls and preserves reasoning across a tool round trip", async () => {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let requestNumber = 0;
  const provider = new DeepSeekProvider({
    apiKey: "test-deepseek-key",
    fetchImpl: async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestNumber += 1;
      if (requestNumber === 1) {
        return new Response([
          'data: {"choices":[{"delta":{"reasoning_content":"Inspect"}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_content":"Inspect scene."}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"demo/main.gd\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response([
        'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const reasoningChunks: string[] = [];
  const baseRequest = {
    model: DEEPSEEK_DEFAULT_MODEL,
    reasoningEffort: "max",
    systemPrompt: "You are GodotX.",
    messages: [{ role: "user" as const, content: "Inspect the script" }],
    tools: [{
      name: "read_file",
      description: "Read a project file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
    onEvent: (event: Parameters<ProviderRequest["onEvent"]>[0]) => {
      if (event.type === "reasoning_delta") reasoningChunks.push(event.text);
    },
  };

  const first = await provider.streamTurn(baseRequest);
  assert.deepEqual(reasoningChunks, ["Inspect", " scene."]);
  assert.deepEqual(first.message, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"demo/main.gd"}' }],
    reasoningContent: "Inspect scene.",
  });
  assert.equal(urls[0], "https://api.deepseek.com/chat/completions");
  assert.equal(urls.some((url) => url.endsWith("/responses")), false);
  assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
  assert.equal(bodies[0]?.reasoning_effort, "max");

  await provider.streamTurn({
    ...baseRequest,
    reasoningEffort: "high",
    messages: [
      ...baseRequest.messages,
      first.message,
      { role: "tool", callId: "call_1", name: "read_file", content: "extends Node" },
      { role: "user", content: "Continue" },
    ],
    onEvent: () => undefined,
  });

  assert.equal(urls[1], "https://api.deepseek.com/chat/completions");
  assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
  assert.equal(bodies[1]?.reasoning_effort, "high");
  assert.deepEqual((bodies[1]?.messages as unknown[])[2], {
    role: "assistant",
    content: null,
    reasoning_content: "Inspect scene.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"demo/main.gd"}' },
    }],
  });
});

test("DeepSeek chat disables thinking without sending reasoning_effort", async () => {
  let body: Record<string, unknown> = {};
  const provider = new DeepSeekProvider({
    apiKey: "test-deepseek-key",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://api.deepseek.com/chat/completions");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n");
    },
  });

  await provider.streamTurn({
    model: "deepseek-chat",
    systemPrompt: "test",
    messages: [{ role: "user", content: "HI" }],
    tools: [],
    onEvent: () => undefined,
  });

  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in body, false);
});
