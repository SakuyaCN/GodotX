import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleProvider,
  ProviderHttpError,
} from "../src/provider/openai-compatible.js";

test("provider rejects unsafe Base URLs before sending credentials", () => {
  assert.throws(
    () => new OpenAICompatibleProvider({ baseUrl: "http://models.example/v1", apiKey: "test-key" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new OpenAICompatibleProvider({ baseUrl: "https://user:pass@models.example/v1", apiKey: "test-key" }),
    /must not contain credentials/,
  );
  assert.throws(
    () => new OpenAICompatibleProvider({ baseUrl: "https://models.example/v1?tenant=a", apiKey: "test-key" }),
    /query or fragment/,
  );
  assert.doesNotThrow(
    () => new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:32145/v1", apiKey: "test-key" }),
  );
});

test("provider lists, validates, deduplicates, and sorts models", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1/",
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({
        object: "list",
        data: [
          { id: "z-model", owned_by: "vendor" },
          { id: "a-model", owned_by: "openai" },
          { id: "z-model", owned_by: "vendor" },
          { id: "bad\nmodel" },
          { object: "model" },
        ],
      });
    },
  });

  assert.deepEqual(await provider.listModels(), [
    {
      id: "a-model",
      ownedBy: "openai",
      capabilities: {
        image_input: {
          status: "unknown",
          mime_types: ["image/png", "image/jpeg", "image/webp"],
          detail_levels: ["low", "high"],
          max_images: 4,
        },
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh"],
          default_effort: "low",
        },
      },
    },
    {
      id: "z-model",
      ownedBy: "vendor",
      capabilities: {
        image_input: {
          status: "unknown",
          mime_types: ["image/png", "image/jpeg", "image/webp"],
          detail_levels: ["low", "high"],
          max_images: 4,
        },
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh"],
          default_effort: "low",
        },
      },
    },
  ]);
  assert.equal(requestedUrl, "https://example.invalid/v1/models");
  assert.equal(requestedAuthorization, "Bearer test-key");
});

test("provider reports model-specific reasoning capabilities", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async () => Response.json({
      data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }],
    }),
  });

  const models = await provider.listModels();
  assert.deepEqual(models[0]?.capabilities?.reasoning, {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    default_effort: "low",
  });
  assert.deepEqual(models[1]?.capabilities?.reasoning, {
    efforts: ["low", "medium", "high", "xhigh"],
    default_effort: "low",
  });
});

test("provider discovers image models from authenticated model IDs", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async () => Response.json({
      data: [
        { id: "gpt-5.6-sol" },
        { id: "image-2" },
        { id: "gpt-image-1" },
        { id: "gpt-image-1.5" },
        { id: "gpt-image-2" },
        { id: "chatgpt-image-latest" },
        { id: "dall-e-2" },
        { id: "dall-e-3" },
        { id: "flux-1" },
      ],
    }),
  });

  assert.deepEqual(await provider.listImageModels(), [
    "chatgpt-image-latest",
    "dall-e-2",
    "dall-e-3",
    "flux-1",
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
  ]);
  assert.deepEqual(await provider.listImageEditModels(), [
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
  ]);
});

test("provider exposes image capabilities and maps a generated image without leaking Base64", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        data: [{ b64_json: Buffer.from(png).toString("base64"), revised_prompt: "Refined prompt" }],
      });
    },
  });

  assert.deepEqual(provider.getImageGenerationCapabilities(), {
    defaultModel: "gpt-image-2",
    models: ["gpt-image-2"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["auto", "low", "medium", "high"],
    backgrounds: ["auto", "opaque", "transparent"],
    outputFormats: ["png", "jpeg", "webp"],
    maxPromptCharacters: 32_000,
  });
  const generated = await provider.generateImage({
    model: "gpt-image-2",
    prompt: "A Godot game icon",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    outputFormat: "png",
  });

  assert.equal(requestedUrl, "https://example.invalid/v1/images/generations");
  assert.deepEqual(requestedBody, {
    model: "gpt-image-2",
    prompt: "A Godot game icon",
    n: 1,
    size: "1024x1024",
    output_format: "png",
    quality: "high",
    background: "transparent",
  });
  assert.deepEqual(generated, {
    bytes: png,
    mimeType: "image/png",
    revisedPrompt: "Refined prompt",
  });
  assert.equal(JSON.stringify(generated).includes(Buffer.from(png).toString("base64")), false);

  await provider.generateImage({
    model: "gpt-image-2",
    prompt: "A custom landscape game background",
    size: "1280x1024",
    outputFormat: "png",
  });
  assert.equal(requestedBody.size, "1280x1024");
});

test("provider edits one image with multipart fields and reuses generated image parsing", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedBody: FormData | undefined;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      assert.ok(init?.body instanceof FormData);
      requestedBody = init.body;
      return Response.json({
        data: [{ b64_json: Buffer.from(png).toString("base64"), revised_prompt: "Restyled sprite" }],
      });
    },
  });

  const edited = await provider.editImage({
    image: { bytes: png, mimeType: "image/png" },
    model: "gpt-image-1.5",
    prompt: "Replace the armor while preserving the silhouette",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    outputFormat: "webp",
    inputFidelity: "high",
  });

  assert.equal(requestedUrl, "https://example.invalid/v1/images/edits");
  assert.equal(requestedHeaders.get("Authorization"), "Bearer test-key");
  assert.equal(requestedHeaders.get("Accept"), "application/json");
  assert.equal(requestedHeaders.get("Content-Type"), null);
  assert.ok(requestedBody);
  assert.deepEqual([...requestedBody.keys()], [
    "image",
    "model",
    "prompt",
    "size",
    "output_format",
    "quality",
    "background",
    "input_fidelity",
  ]);
  assert.equal(requestedBody.get("model"), "gpt-image-1.5");
  assert.equal(requestedBody.get("prompt"), "Replace the armor while preserving the silhouette");
  assert.equal(requestedBody.get("size"), "1024x1024");
  assert.equal(requestedBody.get("quality"), "high");
  assert.equal(requestedBody.get("background"), "transparent");
  assert.equal(requestedBody.get("output_format"), "webp");
  assert.equal(requestedBody.get("input_fidelity"), "high");
  const upload = requestedBody.get("image");
  assert.ok(upload instanceof Blob);
  assert.equal(upload.type, "image/png");
  assert.equal((upload as Blob & { name?: string }).name, "image.png");
  assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), png);
  assert.deepEqual(edited, {
    bytes: png,
    mimeType: "image/png",
    revisedPrompt: "Restyled sprite",
  });
});

test("provider validates image edit source data and input fidelity", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async () => {
      assert.fail("invalid image edits must not reach the provider");
    },
  });
  await assert.rejects(
    provider.editImage({
      image: { bytes: png, mimeType: "image/jpeg" },
      model: "gpt-image-1.5",
      prompt: "test",
    }),
    /MIME type does not match/,
  );
  await assert.rejects(
    provider.editImage({
      image: { bytes: png, mimeType: "image/png" },
      model: "gpt-image-1.5",
      prompt: "test",
      inputFidelity: "invalid" as "high",
    }),
    /Unsupported image input fidelity/,
  );
});

test("provider omits input fidelity for GPT Image 2, which always uses high fidelity", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let requestedBody: FormData | undefined;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      requestedBody = init.body;
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString("base64") }] });
    },
  });

  await provider.editImage({
    image: { bytes: png, mimeType: "image/png" },
    model: "gpt-image-2",
    prompt: "Preserve the source details",
    inputFidelity: "high",
  });

  assert.ok(requestedBody);
  assert.equal(requestedBody.get("input_fidelity"), null);
});

test("provider rejects malformed and oversized image responses", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async () => Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
  });
  await assert.rejects(
    provider.generateImage({ model: "gpt-image-2", prompt: "test" }),
    /unsupported or malformed image/,
  );
  await assert.rejects(
    provider.generateImage({ model: "gpt-image-2", prompt: "test", size: "999x999" }),
    /Unsupported image size/,
  );
  await assert.rejects(
    provider.generateImage({ model: "gpt-image-2", prompt: "test", size: "1024x512" }),
    /Unsupported image size/,
  );
  await assert.rejects(
    provider.generateImage({
      model: "gpt-image-2",
      prompt: "test",
      background: "transparent",
      outputFormat: "jpeg",
    }),
    /require PNG or WebP/,
  );
});

test("provider maps reasoning effort to Responses and Chat request bodies", async () => {
  const responseBodies: Record<string, unknown>[] = [];
  const responses = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "responses",
    fetchImpl: async (_input, init) => {
      responseBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n');
    },
  });
  const chat = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "chat_completions",
    fetchImpl: async (_input, init) => {
      responseBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n");
    },
  });
  const baseRequest = {
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user" as const, content: "HI" }],
    tools: [],
    onEvent: () => undefined,
  };

  await responses.streamTurn({ ...baseRequest, model: "gpt-5.6-sol", reasoningEffort: "max" });
  await chat.streamTurn({ ...baseRequest, reasoningEffort: "low" });
  await responses.streamTurn(baseRequest);
  await chat.streamTurn(baseRequest);

  assert.deepEqual(responseBodies[0]?.reasoning, { effort: "max", summary: "auto" });
  assert.equal(responseBodies[1]?.reasoning_effort, "low");
  assert.equal(Object.hasOwn(responseBodies[2]!, "reasoning"), false);
  assert.equal(Object.hasOwn(responseBodies[3]!, "reasoning_effort"), false);
  await assert.rejects(
    () => responses.streamTurn({ ...baseRequest, reasoningEffort: "max" }),
    /not supported by model "test"/,
  );
  await assert.rejects(
    () => responses.streamTurn({ ...baseRequest, reasoningEffort: "none" as never }),
    /Invalid reasoning effort/,
  );
});

test("provider maps provider-neutral image parts to Responses and Chat without mutating history", async () => {
  const bodies: Record<string, unknown>[] = [];
  const makeProvider = (mode: "responses" | "chat_completions") => new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode,
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(mode === "responses"
        ? 'data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n'
        : "data: [DONE]\n\n");
    },
  });
  const attachmentId = "a".repeat(64);
  const messages = [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Inspect this frame" },
      {
        type: "image" as const,
        attachmentId,
        mimeType: "image/png" as const,
        detail: "high" as const,
      },
    ],
  }];
  const resolveAttachment = async () => ({
    id: attachmentId,
    mimeType: "image/png" as const,
    bytes: Uint8Array.from([1, 2, 3]),
    byteSize: 3,
    width: 1,
    height: 1,
  });
  const request = {
    model: "gpt-5.6-sol",
    systemPrompt: "test",
    messages,
    tools: [],
    resolveAttachment,
    onEvent: () => undefined,
  };

  await makeProvider("responses").streamTurn(request);
  await makeProvider("chat_completions").streamTurn(request);

  assert.deepEqual(bodies[0]?.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "Inspect this frame" },
      { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "high" },
    ],
  }]);
  assert.deepEqual(bodies[1]?.messages, [
    { role: "system", content: "test" },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this frame" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID", detail: "high" },
        },
      ],
    },
  ]);
  assert.equal(messages[0]?.content[1]?.type, "image");
});

test("provider resolves each attachment once when auto mode falls back from Responses to Chat", async () => {
  const attachmentId = "b".repeat(64);
  let resolutions = 0;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "auto",
    fetchImpl: async (input) => String(input).endsWith("/responses")
      ? new Response("Responses endpoint not found", { status: 404 })
      : new Response("data: [DONE]\n\n"),
  });
  await provider.streamTurn({
    model: "gpt-5.6-sol",
    systemPrompt: "test",
    messages: [{
      role: "user",
      content: [{
        type: "image",
        attachmentId,
        mimeType: "image/png",
        detail: "low",
      }],
    }],
    tools: [],
    resolveAttachment: async () => {
      resolutions += 1;
      return {
        id: attachmentId,
        mimeType: "image/png",
        bytes: Uint8Array.from([1]),
        byteSize: 1,
        width: 1,
        height: 1,
      };
    },
    onEvent: () => undefined,
  });
  assert.equal(resolutions, 1);
});

test("Responses stream emits reasoning summaries from delta, done, and completed events without duplication", async () => {
  const events = [
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "先检查",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "场景。",
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      text: "先检查场景。",
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_2",
      output_index: 1,
      summary_index: 0,
      text: "再修改脚本。",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "先检查场景。" }],
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "先检查场景。" }],
          },
          {
            id: "rs_2",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "再修改脚本。" }],
          },
          {
            id: "rs_3",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "完成兜底。" }],
          },
        ],
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const reasoningChunks: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "responses",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });

  await provider.streamTurn({
    model: "gpt-5.6-sol",
    systemPrompt: "test",
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    reasoningEffort: "low",
    onEvent: (event) => {
      if (event.type === "reasoning_delta") reasoningChunks.push(event.text);
    },
  });

  assert.deepEqual(reasoningChunks, ["先检查", "场景。", "再修改脚本。", "完成兜底。"]);
});

test("Responses stream reconciles cumulative summaries by output index when final events add an item id", async () => {
  const summary = "**Inspecting viewport sizes and UI elements**";
  const events = [
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: "**Inspecting viewport",
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: summary,
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_compat",
      output_index: 0,
      summary_index: 0,
      delta: summary,
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_compat",
      output_index: 0,
      summary_index: 0,
      text: summary,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_compat",
        type: "reasoning",
        summary: [{ type: "summary_text", text: summary }],
      },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_markdown",
      output_index: 1,
      summary_index: 0,
      delta: "**",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_markdown",
      output_index: 1,
      summary_index: 0,
      delta: "Checking markdown markers",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_markdown",
      output_index: 1,
      summary_index: 0,
      delta: "**",
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_markdown",
      output_index: 1,
      summary_index: 0,
      text: "**Checking markdown markers**",
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "rs_compat",
            type: "reasoning",
            summary: [{ type: "summary_text", text: summary }],
          },
          {
            id: "rs_markdown",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "**Checking markdown markers**" }],
          },
        ],
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const reasoningChunks: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "responses",
    fetchImpl: async () => new Response(body),
  });

  await provider.streamTurn({
    model: "gpt-5.6-sol",
    systemPrompt: "test",
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    reasoningEffort: "low",
    onEvent: (event) => {
      if (event.type === "reasoning_delta") reasoningChunks.push(event.text);
    },
  });

  assert.deepEqual(reasoningChunks, [
    "**Inspecting viewport",
    " sizes and UI elements**",
    "**",
    "Checking markdown markers",
    "**",
  ]);
  assert.equal(reasoningChunks.slice(0, 2).join(""), summary);
});

test("Responses stream prefers summaries and only falls back to raw reasoning when no summary exists", async () => {
  const collectReasoning = async (events: Record<string, unknown>[]): Promise<string[]> => {
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    const reasoningChunks: string[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      mode: "responses",
      fetchImpl: async () => new Response(body),
    });
    await provider.streamTurn({
      model: "gpt-5.6-sol",
      systemPrompt: "test",
      messages: [{ role: "user", content: "inspect" }],
      tools: [],
      reasoningEffort: "low",
      onEvent: (event) => {
        if (event.type === "reasoning_delta") reasoningChunks.push(event.text);
      },
    });
    return reasoningChunks;
  };
  const sharedText = "Inspecting the current scene.";

  const preferredSummary = await collectReasoning([
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: sharedText,
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: sharedText,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_both",
        type: "reasoning",
        summary: [{ type: "summary_text", text: sharedText }],
        content: [{ type: "reasoning_text", text: sharedText }],
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "rs_both",
            type: "reasoning",
            summary: [{ type: "summary_text", text: sharedText }],
            content: [{ type: "reasoning_text", text: sharedText }],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(preferredSummary, [sharedText]);

  const rawFallback = await collectReasoning([
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Inspecting",
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: sharedText,
    },
    {
      type: "response.reasoning_text.done",
      item_id: "rs_raw",
      output_index: 0,
      content_index: 0,
      text: sharedText,
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "rs_raw",
            type: "reasoning",
            content: [{ type: "reasoning_text", text: sharedText }],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(rawFallback, [sharedText]);
});

test("Chat stream forwards compatible reasoning fields", async () => {
  const body = [
    'data: {"choices":[{"delta":{"reasoning_content":"检查"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"检查场景。"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":"修改脚本。"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const reasoningChunks: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "chat_completions",
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  await provider.streamTurn({
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    onEvent: (event) => {
      if (event.type === "reasoning_delta") reasoningChunks.push(event.text);
    },
  });

  assert.deepEqual(reasoningChunks, ["检查", "场景。", "修改脚本。"]);
});

test("provider redacts credentials from HTTP and streamed errors", async () => {
  const apiKey = "test-secret-api-key";
  const httpProvider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey,
    fetchImpl: async () =>
      new Response(`request exposed ${apiKey} and Bearer another-secret`, { status: 401 }),
  });
  await assert.rejects(() => httpProvider.listModels(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /test-secret-api-key|another-secret/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    () => httpProvider.editImage({
      image: { bytes: png, mimeType: "image/png" },
      model: "gpt-image-1.5",
      prompt: "test",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /test-secret-api-key|another-secret/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );

  const streamProvider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey,
    mode: "responses",
    fetchImpl: async () =>
      new Response(
        `data: ${JSON.stringify({ type: "error", error: { message: `stream exposed ${apiKey}` } })}\n\n`,
      ),
  });
  await assert.rejects(
    () =>
      streamProvider.streamTurn({
        model: "test",
        systemPrompt: "test",
        messages: [{ role: "user", content: "HI" }],
        tools: [],
        onEvent: () => undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /test-secret-api-key/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("provider redacts credentials from HTTP 403 errors", async () => {
  const apiKey = "test-forbidden-api-key";
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey,
    fetchImpl: async () =>
      new Response(`request exposed ${apiKey} and Bearer another-forbidden-secret`, { status: 403 }),
  });

  await assert.rejects(() => provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^HTTP 403:/u);
    assert.doesNotMatch(error.message, /test-forbidden-api-key|another-forbidden-secret/u);
    assert.match(error.message, /\[REDACTED\]/u);
    return true;
  });
});

test("provider classifies Zen credit exhaustion as billing and removes tenant billing details", async () => {
  const workspaceId = "wrk_01KVZ8SWFCWGSBX6RA1WCQ6K24";
  const billingUrl = `https://opencode.ai/workspace/${workspaceId}/billing`;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "expired-credit-key",
    fetchImpl: async () => Response.json(
      {
        type: "error",
        error: {
          type: "CreditsError",
          message: `Insufficient balance. Manage your billing here: ${billingUrl}`,
        },
      },
      { status: 401 },
    ),
  });

  await assert.rejects(() => provider.listModels(), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 401);
    assert.equal(error.category, "billing");
    assert.match(error.message, /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/iu);
    assert.doesNotMatch(error.message, /https?:\/\//u);
    assert.doesNotMatch(error.message, new RegExp(workspaceId, "u"));
    return true;
  });
});

test("image editing surfaces HTTP 200 provider error envelopes instead of reporting an empty result", async () => {
  const workspaceId = "wrk_IMAGE_BILLING_PRIVATE";
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "expired-image-credit-key",
    fetchImpl: async () => Response.json({
      type: "error",
      error: {
        type: "CreditsError",
        message: `Insufficient balance: https://opencode.ai/workspace/${workspaceId}/billing`,
      },
    }),
  });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(
    provider.editImage({
      image: { bytes: png, mimeType: "image/png" },
      model: "gpt-image-2",
      prompt: "Reskin this sprite",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, 200);
      assert.equal(error.category, "billing");
      assert.doesNotMatch(error.message, /https?:\/\//u);
      assert.doesNotMatch(error.message, new RegExp(workspaceId, "u"));
      return true;
    },
  );
});

test("Responses stream merges item_id and call_id into one tool call", async () => {
  const events = [
    {
      type: "response.output_item.added",
      item: { id: "fc_item_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '{"path":"demo' },
    { type: "response.function_call_arguments.delta", item_id: "fc_item_1", delta: '/main.gd"}' },
    {
      type: "response.output_item.done",
      item: {
        id: "fc_item_1",
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"demo/main.gd"}',
      },
    },
    {
      type: "response.completed",
      response: {
        output: [
          {
            id: "fc_item_1",
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"demo/main.gd"}',
          },
        ],
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "responses",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });
  const result = await provider.streamTurn({
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user", content: "read" }],
    tools: [],
    onEvent: () => undefined,
  });
  assert.deepEqual(result.message.toolCalls, [
    { id: "call_1", name: "read_file", arguments: '{"path":"demo/main.gd"}' },
  ]);
});

test("auto mode falls back to streamed Chat Completions", async () => {
  let requests = 0;
  const providerEvents: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "auto",
    fetchImpl: async (input) => {
      requests += 1;
      if (String(input).endsWith("/responses")) return new Response("not supported", { status: 404 });
      const body = [
        'data: {"choices":[{"delta":{"content":"H"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"I"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const result = await provider.streamTurn({
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user", content: "HI" }],
    tools: [],
    onEvent: (event) => providerEvents.push(event.type),
  });
  assert.equal(requests, 2);
  assert.equal(result.message.content, "HI");
  assert.deepEqual(providerEvents, ["fallback", "text_delta", "text_delta"]);
});

test("auto endpoint detection is cached independently for each model", async () => {
  const requests: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "auto",
    fetchImpl: async (input, init) => {
      const requestPath = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as { model: string };
      requests.push(`${body.model}:${requestPath}`);
      if (body.model === "responses-model" && requestPath.endsWith("/responses")) {
        return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n');
      }
      if (body.model === "chat-model" && requestPath.endsWith("/responses")) {
        return new Response("Responses endpoint not found", { status: 404 });
      }
      return new Response("data: [DONE]\n\n");
    },
  });
  const makeRequest = (model: string) => ({
    model,
    systemPrompt: "test",
    messages: [{ role: "user" as const, content: "HI" }],
    tools: [],
    onEvent: () => undefined,
  });

  await provider.streamTurn(makeRequest("responses-model"));
  await provider.streamTurn(makeRequest("chat-model"));
  await provider.streamTurn(makeRequest("chat-model"));

  assert.deepEqual(requests, [
    "responses-model:/v1/responses",
    "chat-model:/v1/responses",
    "chat-model:/v1/chat/completions",
    "chat-model:/v1/chat/completions",
  ]);
});

test("Chat stream merges tool argument chunks even when index is omitted", async () => {
  const body = [
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"demo/main.gd\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "chat_completions",
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const result = await provider.streamTurn({
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user", content: "read" }],
    tools: [],
    onEvent: () => undefined,
  });
  assert.deepEqual(result.message.toolCalls, [
    { id: "call_1", name: "read_file", arguments: '{"path":"demo/main.gd"}' },
  ]);
});

test("Chat stream surfaces HTTP-200 error events", async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "chat_completions",
    fetchImpl: async () => new Response('data: {"error":{"message":"upstream failed"}}\n\n'),
  });
  await assert.rejects(
    provider.streamTurn({
      model: "test",
      systemPrompt: "test",
      messages: [{ role: "user", content: "HI" }],
      tools: [],
      onEvent: () => undefined,
    }),
    /upstream failed/,
  );
});

test("synthetic tool call ids are unique across provider turns", async () => {
  const body = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"read_file","arguments":"{}"}}\n\n',
    'data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"read_file","arguments":"{}"}]}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    mode: "responses",
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const request = {
    model: "test",
    systemPrompt: "test",
    messages: [{ role: "user" as const, content: "read" }],
    tools: [],
    onEvent: () => undefined,
  };
  const first = await provider.streamTurn(request);
  const second = await provider.streamTurn(request);
  assert.equal(first.message.toolCalls.length, 1);
  assert.equal(second.message.toolCalls.length, 1);
  assert.notEqual(first.message.toolCalls[0]?.id, second.message.toolCalls[0]?.id);
});
