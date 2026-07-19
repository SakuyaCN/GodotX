import assert from "node:assert/strict";
import test from "node:test";
import {
  getOpenCodeZenModelCapabilities,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OpenCodeZenProvider,
} from "../src/provider/opencode-zen.js";
import type { ModelProvider, ProviderRequest } from "../src/provider/types.js";

const UNSUPPORTED_IMAGE_INPUT = {
  status: "unsupported",
  mime_types: [],
  detail_levels: [],
  max_images: 0,
};

const SUPPORTED_IMAGE_INPUT = {
  status: "supported",
  mime_types: ["image/png", "image/jpeg", "image/webp"],
  detail_levels: ["low", "high"],
  max_images: 4,
};

const makeRequest = (model: string): ProviderRequest => ({
  model,
  systemPrompt: "You are GodotX.",
  messages: [{ role: "user", content: "HI" }],
  tools: [],
  onEvent: () => undefined,
});

test("OpenCode Zen lists only Runtime-supported protocols with Bearer authentication", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "https://models.dev/api.json") {
        return Response.json({
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            models: {
              "qwen3.5-plus": zenMetadata("qwen3.5-plus", "@ai-sdk/anthropic"),
              "gpt-5.6-sol": zenMetadata("gpt-5.6-sol", "@ai-sdk/openai", true),
              "gemini-3-flash": zenMetadata("gemini-3-flash", "@ai-sdk/google", true),
              "deepseek-v4-flash": zenMetadata("deepseek-v4-flash", ""),
              "claude-sonnet-4-5": zenMetadata("claude-sonnet-4-5", "@ai-sdk/anthropic", true),
              "grok-4.5": zenMetadata("grok-4.5", "@ai-sdk/openai", true),
            },
          },
        });
      }
      assert.equal(url, "https://opencode.ai/zen/v1/models");
      return Response.json({
        object: "list",
        data: [
          { id: "qwen3.5-plus", owned_by: "alibaba" },
          { id: "gpt-5.6-sol", owned_by: "openai" },
          { id: "gemini-3-flash", owned_by: "google" },
          { id: "deepseek-v4-flash", owned_by: "deepseek" },
          { id: "claude-sonnet-4-5", owned_by: "anthropic" },
          { id: "grok-4.5", owned_by: "xai" },
        ],
      });
    },
  });

  assert.equal(OPENCODE_ZEN_BASE_URL, "https://opencode.ai/zen/v1");
  assert.equal(OPENCODE_ZEN_DEFAULT_MODEL, "gpt-5.6-sol");
  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), [
    "deepseek-v4-flash",
    "gpt-5.6-sol",
    "grok-4.5",
  ]);
  assert.deepEqual(models.find((model) => model.id === "deepseek-v4-flash")?.capabilities, {
    reasoning: { efforts: ["high", "max"], default_effort: "high" },
    image_input: UNSUPPORTED_IMAGE_INPUT,
  });
  assert.deepEqual(models.find((model) => model.id === "gpt-5.6-sol")?.capabilities, {
    reasoning: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      default_effort: "low",
    },
    image_input: SUPPORTED_IMAGE_INPUT,
  });
  assert.equal(requests.length, 2);
  const zenRequest = requests.find((request) => request.url === "https://opencode.ai/zen/v1/models");
  const metadataRequest = requests.find((request) => request.url === "https://models.dev/api.json");
  assert.ok(zenRequest);
  assert.equal(zenRequest.init?.method, "GET");
  assert.equal(new Headers(zenRequest.init?.headers).get("Authorization"), "Bearer test-zen-key");
  assert.ok(metadataRequest);
  assert.equal(new Headers(metadataRequest.init?.headers).get("Authorization"), null);
});

test("OpenCode Zen routes GPT models to Responses", async () => {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"HI"}\n\n',
        'data: {"type":"response.completed","response":{"output":[]}}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const events: string[] = [];

  const result = await provider.streamTurn({
    ...makeRequest("gpt-5.6-sol"),
    reasoningEffort: "max",
    onEvent: (event) => events.push(event.type),
  });

  assert.deepEqual(urls, ["https://opencode.ai/zen/v1/responses"]);
  assert.equal(bodies[0]?.model, "gpt-5.6-sol");
  assert.deepEqual(bodies[0]?.reasoning, { effort: "max", summary: "auto" });
  assert.equal(Object.hasOwn(bodies[0]!, "reasoning_effort"), false);
  assert.deepEqual(result.message, { role: "assistant", content: "HI", toolCalls: [] });
  assert.deepEqual(events, ["text_delta"]);
});

test("OpenCode Zen routes compatible non-GPT models to Chat Completions", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"choices":[{"delta":{"content":"Ready"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const result = await provider.streamTurn({
    ...makeRequest("deepseek-v4-flash"),
    reasoningEffort: "max",
  });

  assert.equal(url, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.reasoning_effort, "max");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(result.message.content, "Ready");
});

test("OpenCode Zen routes OpenCode-metadata Grok models to Responses", async () => {
  const urls: string[] = [];
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(
        'data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });

  await provider.streamTurn({ ...makeRequest("grok-4.5"), reasoningEffort: "high" });

  assert.deepEqual(urls, ["https://opencode.ai/zen/v1/responses"]);
});

test("OpenCode Zen rejects models requiring unsupported native protocols before inference HTTP", async () => {
  let inferenceRequestCount = 0;
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input) => {
      if (String(input) === "https://models.dev/api.json") return Response.json({});
      inferenceRequestCount += 1;
      return new Response("data: [DONE]\n\n");
    },
  });

  await assert.rejects(
    () => provider.streamTurn(makeRequest("claude-sonnet-4-5")),
    /requires the unsupported anthropic_messages protocol/u,
  );
  await assert.rejects(
    () => provider.streamTurn(makeRequest("qwen3.5-plus")),
    /requires the unsupported anthropic_messages protocol/u,
  );
  await assert.rejects(
    () => provider.streamTurn(makeRequest("gemini-3-flash")),
    /requires the unsupported google_generate_content protocol/u,
  );
  await assert.rejects(
    () => provider.streamTurn(makeRequest("future-unclassified-model")),
    /unknown|unsupported|metadata/iu,
  );
  assert.equal(inferenceRequestCount, 0);
});

function zenMetadata(id: string, npm: string, attachment = false): Record<string, unknown> {
  const effortValues = id === "gpt-5.6-sol"
    ? ["none", "low", "medium", "high", "xhigh", "max"]
    : id === "deepseek-v4-flash"
      ? ["high", "max"]
      : id === "grok-4.5"
        ? ["low", "medium", "high"]
        : [];
  return {
    id,
    name: id,
    attachment,
    reasoning: true,
    reasoning_options: effortValues.length > 0
      ? [{ type: "effort", values: effortValues }]
      : [],
    tool_call: true,
    modalities: {
      input: attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    ...(npm ? { provider: { npm } } : {}),
  };
}

test("OpenCode Zen DeepSeek preserves reasoning_content across a tool round trip", async () => {
  const bodies: Record<string, unknown>[] = [];
  let requestNumber = 0;
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://opencode.ai/zen/v1/chat/completions");
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
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const request = {
    ...makeRequest("deepseek-v4-flash"),
    reasoningEffort: "max",
    tools: [{
      name: "read_file",
      description: "Read a project file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
  } satisfies ProviderRequest;

  const first = await provider.streamTurn(request);
  assert.deepEqual(first.message, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"demo/main.gd"}' }],
    reasoningContent: "Inspect scene.",
  });
  assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
  assert.equal(bodies[0]?.reasoning_effort, "max");

  await provider.streamTurn({
    ...request,
    messages: [
      ...request.messages,
      first.message,
      { role: "tool", callId: "call_1", name: "read_file", content: "extends Node" },
      { role: "user", content: "Continue" },
    ],
  });

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

test("OpenCode Zen exposes explicit capabilities and rejects unsupported images before HTTP", async () => {
  let requestCount = 0;
  const provider = new OpenCodeZenProvider({
    apiKey: "test-zen-key",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("data: [DONE]\n\n");
    },
  });
  const imageProvider = provider as ModelProvider;

  assert.deepEqual(getOpenCodeZenModelCapabilities("gpt-5.6-sol"), {
    reasoning: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      default_effort: "low",
    },
    image_input: SUPPORTED_IMAGE_INPUT,
  });
  assert.deepEqual(
    getOpenCodeZenModelCapabilities("gpt-5.3-codex-spark").image_input,
    UNSUPPORTED_IMAGE_INPUT,
  );
  assert.deepEqual(
    getOpenCodeZenModelCapabilities("deepseek-v4-flash").image_input,
    UNSUPPORTED_IMAGE_INPUT,
  );
  assert.equal(imageProvider.getImageGenerationCapabilities, undefined);
  assert.equal(imageProvider.listImageModels, undefined);
  assert.equal(imageProvider.generateImage, undefined);
  assert.equal(imageProvider.editImage, undefined);

  await assert.rejects(
    () => provider.streamTurn({
      ...makeRequest("deepseek-v4-flash"),
      messages: [{
        role: "user",
        content: [{
          type: "image",
          attachmentId: "a".repeat(64),
          mimeType: "image/png",
          detail: "high",
        }],
      }],
      resolveAttachment: async () => ({
        id: "a".repeat(64),
        mimeType: "image/png",
        bytes: Uint8Array.of(1),
        width: 1,
        height: 1,
        byteSize: 1,
      }),
    }),
    /does not support image input/u,
  );
  assert.equal(requestCount, 0);
});
