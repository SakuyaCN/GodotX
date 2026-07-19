import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { PNG } from "pngjs";
import WebSocket from "ws";
import { AttachmentStore } from "../src/attachment-store.js";
import type { ProviderDefinition, ProviderConfigValidationResult } from "../src/provider/registry.js";
import { ProviderRegistry } from "../src/provider/registry.js";
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerationCapabilities,
  ImageGenerationRequest,
  ModelProvider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderRequest,
  ProviderTurnResult,
} from "../src/provider/types.js";
import { startServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

for (const status of [401, 403] as const) {
  test(`server classifies provider HTTP ${status} as an authentication failure without leaking credentials`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `godetx-auth-${status}-`));
    const apiKey = `invalid-provider-key-${status}`;
    const echoedBearer = `echoed-provider-secret-${status}`;
    let modelRequests = 0;
    const providerServer = createHttpServer((request, response) => {
      if (request.url !== "/v1/models") {
        response.writeHead(404).end("not found");
        return;
      }
      modelRequests += 1;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: `credentials ${apiKey}; Authorization: Bearer ${echoedBearer}`,
        },
      }));
    });
    await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerAddress = providerServer.address();
    assert.ok(providerAddress && typeof providerAddress !== "string");

    const token = `auth-capability-token-${status}`;
    const server = await startServer({
      workspace: root,
      port: 0,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    });
    t.after(async () => {
      for (const client of server.clients) client.terminate();
      if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
      providerServer.closeAllConnections();
      if (providerServer.listening) {
        await new Promise<void>((resolve) => providerServer.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
    t.after(() => socket.terminate());
    const messages: unknown[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(() => messages.some((message) => (
      message as { event?: { type?: string } }
    ).event?.type === "server.ready"));

    socket.send(JSON.stringify({
      id: `configure-${status}`,
      method: "configure",
      params: {
        base_url: `http://127.0.0.1:${providerAddress.port}/v1`,
        api_key: apiKey,
        model: "test-model",
      },
    }));
    await waitFor(() => hasResponse(messages, `configure-${status}`));
    assert.equal(responseFor(messages, `configure-${status}`).error, undefined);
    assert.equal(modelRequests, 0, "configure must not preflight the provider model endpoint");

    socket.send(JSON.stringify({ id: `models-${status}`, method: "models.list", params: {} }));
    await waitFor(() => hasResponse(messages, `models-${status}`));
    const response = responseFor(messages, `models-${status}`);
    assert.equal(response.result, undefined);
    assert.equal(response.error?.code, "PROVIDER_AUTH_FAILED");
    assert.deepEqual(response.error?.data, { status });
    assert.match(response.error?.message ?? "", new RegExp(`^HTTP ${status}:`, "u"));
    assert.doesNotMatch(response.error?.message ?? "", new RegExp(`${apiKey}|${echoedBearer}`, "u"));
    assert.match(response.error?.message ?? "", /\[REDACTED\]/u);
    assert.equal(modelRequests, 1);
  });
}

test("server reports Zen credit exhaustion as billing without exposing workspace billing details", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-billing-"));
  const workspaceId = "wrk_01KVZ8SWFCWGSBX6RA1WCQ6K24";
  const billingUrl = `https://opencode.ai/workspace/${workspaceId}/billing`;
  let modelRequests = 0;
  const providerServer = createHttpServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end("not found");
      return;
    }
    modelRequests += 1;
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "CreditsError",
        message: `Insufficient balance. Manage your billing here: ${billingUrl}`,
      },
    }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");

  const token = "billing-capability-token";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    providerServer.closeAllConnections();
    if (providerServer.listening) {
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  t.after(() => socket.terminate());
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "server.ready"));

  socket.send(JSON.stringify({
    id: "configure-billing",
    method: "configure",
    params: {
      base_url: `http://127.0.0.1:${providerAddress.port}/v1`,
      api_key: "credit-exhausted-key",
      model: "test-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-billing"));
  assert.equal(responseFor(messages, "configure-billing").error, undefined);

  socket.send(JSON.stringify({ id: "models-billing", method: "models.list", params: {} }));
  await waitFor(() => hasResponse(messages, "models-billing"));
  const response = responseFor(messages, "models-billing");
  assert.equal(response.result, undefined);
  assert.equal(response.error?.code, "PROVIDER_BILLING_FAILED");
  assert.deepEqual(response.error?.data, { status: 401 });
  assert.match(response.error?.message ?? "", /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/iu);
  assert.doesNotMatch(response.error?.message ?? "", /https?:\/\//u);
  assert.doesNotMatch(response.error?.message ?? "", new RegExp(workspaceId, "u"));
  assert.equal(modelRequests, 1);
});

test("server exposes project index and SkillX management before provider configuration", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-skillx-server-"));
  const dataDirectory = path.join(root, "user-data");
  await writeFile(path.join(root, "project.godot"), "[application]\nconfig/name=\"SkillX Test\"\n");
  await writeFile(path.join(root, "player.gd"), "class_name SkillXPlayer\nfunc move_player():\n    pass\n");
  const token = "skillx-capability-token";
  const server = await startServer({
    workspace: root,
    dataDirectory,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "server.ready"));

  socket.send(JSON.stringify({
    id: "skill-save",
    method: "skills.save",
    params: {
      scope: "project",
      name: "movement-review",
      description: "Review player movement scripts",
      instructions: "Inspect movement symbols and references before editing.",
      triggers: ["movement review"],
      capabilities: ["project_symbol_search"],
      enabled: true,
    },
  }));
  await waitFor(() => hasResponse(messages, "skill-save"));
  const saved = responseFor(messages, "skill-save").result as { skill?: { id?: string; instructions?: string } };
  assert.equal(saved.skill?.id, "project:movement-review");
  assert.match(saved.skill?.instructions ?? "", /movement symbols/u);

  socket.send(JSON.stringify({ id: "skill-list", method: "skills.list", params: {} }));
  await waitFor(() => hasResponse(messages, "skill-list"));
  const listed = responseFor(messages, "skill-list").result as {
    skills?: Array<{ id?: string }>;
    index?: { state?: string };
  };
  assert.ok(listed.skills?.some((skill) => skill.id === "project:movement-review"));
  assert.ok(new Set(["idle", "scanning", "ready"]).has(listed.index?.state ?? ""));

  socket.send(JSON.stringify({ id: "index-rebuild", method: "index.rebuild", params: {} }));
  await waitFor(() => hasResponse(messages, "index-rebuild"));
  const rebuilt = responseFor(messages, "index-rebuild").result as {
    index?: { state?: string; symbol_count?: number };
  };
  assert.equal(rebuilt.index?.state, "ready");
  assert.ok((rebuilt.index?.symbol_count ?? 0) >= 2);

  socket.send(JSON.stringify({
    id: "skill-delete",
    method: "skills.delete",
    params: { id: "project:movement-review" },
  }));
  await waitFor(() => hasResponse(messages, "skill-delete"));
  assert.equal((responseFor(messages, "skill-delete").result as { deleted?: boolean }).deleted, true);
});

test("WebSocket server emits versioned ready event and answers ping", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-server-"));
  let delayModels = false;
  const delayedModelResponse: { release?: () => void } = {};
  const providerServer = createHttpServer((request, response) => {
    if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer test") {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (delayModels) {
      delayedModelResponse.release = () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ object: "list", data: [{ id: "model-b" }, { id: "model-a" }] }));
      };
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "model-b" }, { id: "model-a" }] }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    providerServer.closeAllConnections();
    if (providerServer.listening) {
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    }
  });
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
  const token = "test-capability-token";
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const server = await startServer({ workspace: root, port: 0, tokenSha256 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const rejectedStatus = await new Promise<number>((resolve, reject) => {
    const unauthorized = new WebSocket(`ws://127.0.0.1:${address.port}/`);
    unauthorized.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    unauthorized.once("open", () => reject(new Error("Unauthenticated WebSocket unexpectedly opened")));
  });
  assert.equal(rejectedStatus, 401);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.length >= 1);
  assert.deepEqual((messages[0] as { event: { version: number; type: string } }).event, {
    version: 1,
    seq: 1,
    time: (messages[0] as { event: { time: string } }).event.time,
    type: "server.ready",
    data: { protocol_version: 1, workspace: path.resolve(root) },
  });
  socket.send(JSON.stringify({ id: "1", method: "ping", params: {} }));
  await waitFor(() => messages.length >= 2);
  assert.deepEqual(messages[1], { id: "1", result: { pong: true } });
  socket.send(
    JSON.stringify({
      id: "2",
      method: "approval.respond",
      params: { request_id: "missing", decision: "bogus" },
    }),
  );
  await waitFor(() => messages.length >= 3);
  assert.match(
    (messages[2] as { error: { message: string } }).error.message,
    /Invalid approval decision/,
  );
  socket.send(
    JSON.stringify({
      id: "3",
      method: "configure",
      params: { base_url: providerBaseUrl, api_key: "test", model: "test" },
    }),
  );
  await waitFor(() => messages.length >= 4);
  socket.send(JSON.stringify({ id: "4", method: "models.list", params: {} }));
  await waitFor(() => messages.length >= 5);
  const modelResponse = messages[4] as {
    id: string;
    result: { models: Array<{ id: string; capabilities?: { reasoning?: { efforts?: string[] } } }> };
  };
  assert.equal(modelResponse.id, "4");
  assert.deepEqual(modelResponse.result.models.map((entry) => entry.id), ["model-a", "model-b"]);
  assert.deepEqual(modelResponse.result.models[0]?.capabilities?.reasoning?.efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  socket.send(JSON.stringify({ id: "5", method: "session.create", params: {} }));
  await waitFor(() => messages.length >= 7);
  const sessionEvent = messages.find(
    (message) => (message as { event?: { type?: string } }).event?.type === "session.created",
  ) as { event: { seq: number; data: { session_id: string } } } | undefined;
  assert.equal(sessionEvent?.event.seq, 2);
  socket.send(
    JSON.stringify({
      id: "6",
      method: "turn.start",
      params: { session_id: sessionEvent?.event.data.session_id, prompt: "HI", reasoning_effort: "turbo" },
    }),
  );
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "6"));
  const invalidEffort = messages.find((message) => (message as { id?: string }).id === "6") as
    | { error?: { message?: string }; result?: unknown }
    | undefined;
  assert.equal(invalidEffort?.result, undefined);
  assert.match(invalidEffort?.error?.message ?? "", /not supported by model "test"/);
  socket.send(
    JSON.stringify({
      id: "6-none",
      method: "turn.start",
      params: { session_id: sessionEvent?.event.data.session_id, prompt: "HI", reasoning_effort: "none" },
    }),
  );
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "6-none"));
  const removedEffort = messages.find((message) => (message as { id?: string }).id === "6-none") as
    | { error?: { message?: string }; result?: unknown }
    | undefined;
  assert.equal(removedEffort?.result, undefined);
  assert.match(removedEffort?.error?.message ?? "", /not supported by model "test"/);
  socket.send(
    JSON.stringify({
      id: "6-max",
      method: "turn.start",
      params: {
        session_id: sessionEvent?.event.data.session_id,
        prompt: "HI",
        model: "gpt-5.6-terra",
        reasoning_effort: "max",
      },
    }),
  );
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "6-max"));
  const restrictedMax = messages.find((message) => (message as { id?: string }).id === "6-max") as
    | { error?: { message?: string }; result?: unknown }
    | undefined;
  assert.equal(restrictedMax?.result, undefined);
  assert.match(restrictedMax?.error?.message ?? "", /not supported by model "gpt-5\.6-terra"/);
  socket.send(
    JSON.stringify({ id: "7", method: "turn.start", params: { session_id: "missing", prompt: "HI" } }),
  );
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "7"));
  const invalidTurn = messages.find((message) => (message as { id?: string }).id === "7") as
    | { error?: { message?: string }; result?: unknown }
    | undefined;
  assert.equal(invalidTurn?.result, undefined);
  assert.match(invalidTurn?.error?.message ?? "", /Unknown session/);

  delayModels = true;
  socket.send(JSON.stringify({ id: "8", method: "models.list", params: {} }));
  await waitFor(() => Boolean(delayedModelResponse.release));
  socket.send(JSON.stringify({ id: "9", method: "ping", params: {} }));
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "9"));
  assert.deepEqual(
    messages.find((message) => (message as { id?: string }).id === "9"),
    { id: "9", result: { pong: true } },
  );
  assert.equal(messages.some((message) => (message as { id?: string }).id === "8"), false);
  socket.send(
    JSON.stringify({ id: "10", method: "turn.cancel", params: { session_id: "missing" } }),
  );
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "10"));
  assert.match(
    (messages.find((message) => (message as { id?: string }).id === "10") as { error: { message: string } }).error
      .message,
    /Unknown session/,
  );
  assert.equal(messages.some((message) => (message as { id?: string }).id === "8"), false);
  delayedModelResponse.release?.();
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "8"));
  socket.send(JSON.stringify({ id: "11", method: "providers.list", params: {} }));
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "11"));
  const providerResponse = messages.find((message) => (message as { id?: string }).id === "11") as {
    result: {
      providers: Array<{
        id: string;
        display_name: string;
        default_model?: string;
        config_fields: Array<Record<string, unknown>>;
      }>;
    };
  };
  assert.deepEqual(providerResponse.result.providers.map((entry) => entry.id), [
    "openai-compatible",
    "deepseek",
    "opencode-zen",
  ]);
  assert.equal(providerResponse.result.providers[0]?.default_model, "gpt-5.6-sol");
  assert.ok((providerResponse.result.providers[0]?.config_fields.length ?? 0) >= 3);
  const deepSeekDefinition = providerResponse.result.providers.find((entry) => entry.id === "deepseek");
  assert.equal(deepSeekDefinition?.default_model, "deepseek-v4-flash");
  assert.deepEqual(deepSeekDefinition?.config_fields, [
    { key: "api_key", label: "API key", type: "secret", required: true },
  ]);
  const openCodeZenDefinition = providerResponse.result.providers.find((entry) => entry.id === "opencode-zen");
  assert.deepEqual(openCodeZenDefinition, {
    id: "opencode-zen",
    display_name: "OpenCode Zen",
    default_model: "gpt-5.6-sol",
    config_fields: [
      { key: "api_key", label: "API key", type: "secret", required: true },
    ],
  });
  socket.send(JSON.stringify({
    id: "editor-unknown",
    method: "editor.tool.respond",
    params: { request_id: "editor_missing", result: { ok: true } },
  }));
  await waitFor(() => messages.some((message) => (message as { id?: string }).id === "editor-unknown"));
  const unknownEditorResponse = messages.find(
    (message) => (message as { id?: string }).id === "editor-unknown",
  ) as { error?: { code?: string; data?: unknown } } | undefined;
  assert.equal(unknownEditorResponse?.error?.code, "EDITOR_REQUEST_NOT_FOUND");
  assert.deepEqual(unknownEditorResponse?.error?.data, { request_id: "editor_missing" });
  socket.close();
});

test("default DeepSeek provider reports image generation as unsupported without discovery", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-deepseek-capabilities-"));
  const token = "deepseek-image-capability-token";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  t.after(() => socket.terminate());
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "server.ready"));

  socket.send(JSON.stringify({
    id: "configure-deepseek",
    method: "configure",
    params: {
      provider_id: "deepseek",
      provider_config: { api_key: "test-deepseek-key" },
      model: "deepseek-v4-flash",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-deepseek"));
  assert.equal(responseFor(messages, "configure-deepseek").error, undefined);

  socket.send(JSON.stringify({
    id: "deepseek-image-capabilities",
    method: "image.capabilities",
    params: {},
  }));
  await waitFor(() => hasResponse(messages, "deepseek-image-capabilities"));
  assert.deepEqual(responseFor(messages, "deepseek-image-capabilities").result, {
    supported: false,
    edit_supported: false,
    edit_models: [],
  });
});

test("default OpenCode Zen provider validates its API key and does not expose ImageX", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-opencode-zen-capabilities-"));
  const token = "opencode-zen-image-capability-token";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  t.after(() => socket.terminate());
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "server.ready"));

  socket.send(JSON.stringify({
    id: "configure-opencode-zen-missing-key",
    method: "configure",
    params: {
      provider_id: "opencode-zen",
      provider_config: {},
      model: "gpt-5.6-sol",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-opencode-zen-missing-key"));
  const invalidConfig = responseFor(messages, "configure-opencode-zen-missing-key");
  assert.equal(invalidConfig.result, undefined);
  assert.equal(invalidConfig.error?.code, "REQUEST_FAILED");
  assert.match(
    invalidConfig.error?.message ?? "",
    /Invalid configuration for provider "opencode-zen": api_key: is required/u,
  );

  socket.send(JSON.stringify({
    id: "configure-opencode-zen",
    method: "configure",
    params: {
      provider_id: "opencode-zen",
      provider_config: { api_key: "test-opencode-zen-key" },
      model: "gpt-5.6-sol",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-opencode-zen"));
  assert.equal(responseFor(messages, "configure-opencode-zen").error, undefined);

  socket.send(JSON.stringify({
    id: "opencode-zen-image-capabilities",
    method: "image.capabilities",
    params: {},
  }));
  await waitFor(() => hasResponse(messages, "opencode-zen-image-capabilities"));
  assert.deepEqual(responseFor(messages, "opencode-zen-image-capabilities").result, {
    supported: false,
    edit_supported: false,
    edit_models: [],
  });
});

test("server generates an image artifact through the configured provider", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-image-server-"));
  const instances: TestProvider[] = [];
  const providerRegistry = new ProviderRegistry([testProviderDefinition(instances)]);
  const token = "image-provider-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-image",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "image" },
      model: "image-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-image"));
  socket.send(JSON.stringify({ id: "image-capabilities", method: "image.capabilities", params: {} }));
  await waitFor(() => hasResponse(messages, "image-capabilities"));
  const capabilities = responseFor(messages, "image-capabilities") as {
    result: {
      supported: boolean;
      edit_supported: boolean;
      edit_models: string[];
      default_model: string;
      output_formats: string[];
    };
  };
  assert.deepEqual(capabilities.result, {
    supported: true,
    edit_supported: true,
    edit_models: ["gpt-image-2", "gpt-image-1.5"],
    default_model: "gpt-image-2",
    models: ["gpt-image-2", "gpt-image-1", "gpt-image-1.5"],
    sizes: ["1024x1024"],
    qualities: ["auto", "high"],
    backgrounds: ["auto", "transparent"],
    output_formats: ["png"],
    max_prompt_characters: 32_000,
  });

  socket.send(JSON.stringify({
    id: "generate-image",
    method: "image.generate",
    params: {
      generation_id: "generation_test_1",
      prompt: "A test image",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
      target_width: 64,
      target_height: 32,
    },
  }));
  await waitFor(() => hasResponse(messages, "generate-image"));
  const response = responseFor(messages, "generate-image") as {
    result: {
      resource_path: string;
      path: string;
      mime_type: string;
      revised_prompt: string;
      transparency_mode: string;
      resized: boolean;
      source_width: number;
      source_height: number;
      output_width: number;
      output_height: number;
    };
  };
  assert.match(response.result.resource_path, /^res:\/\/assets\/generated\/imagex-.*\.png$/u);
  assert.equal(response.result.mime_type, "image/png");
  assert.equal(response.result.revised_prompt, "Refined by test provider");
  assert.equal(response.result.transparency_mode, "native");
  assert.equal(response.result.resized, true);
  assert.deepEqual(
    [response.result.source_width, response.result.source_height, response.result.output_width, response.result.output_height],
    [8, 8, 64, 32],
  );
  const storedImage = await readFile(path.join(root, ...response.result.path.split("/")));
  assert.deepEqual([...storedImage.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(
    [PNG.sync.read(storedImage).width, PNG.sync.read(storedImage).height],
    [64, 32],
  );
  assert.equal(JSON.stringify(response).includes("iVBOR"), false);
});

test("server edits sprite and atlas PNGs from registered attachments and rejects invalid geometry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-sprite-edit-server-"));
  const attachmentStore = AttachmentStore.forWorkspace(root);
  const sourceBytes = makeTransparentGeneratedPng(32, 16);
  const sourceId = createHash("sha256").update(sourceBytes).digest("hex");
  const sourcePath = path.join(attachmentStore.directory, `${sourceId}.png`);
  await writeFile(sourcePath, sourceBytes);
  const invalidBytes = makeTransparentGeneratedPng(30, 16);
  const invalidId = createHash("sha256").update(invalidBytes).digest("hex");
  await writeFile(path.join(attachmentStore.directory, `${invalidId}.png`), invalidBytes);
  const jpegBytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00,
    0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  const jpegId = createHash("sha256").update(jpegBytes).digest("hex");
  await writeFile(path.join(attachmentStore.directory, `${jpegId}.jpg`), jpegBytes);

  const instances: TestProvider[] = [];
  const providerRegistry = new ProviderRegistry([testProviderDefinition(instances)]);
  const token = "sprite-edit-provider-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
    attachmentStore,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-sprite-edit",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "sprite-edit" },
      model: "image-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-sprite-edit"));
  socket.send(JSON.stringify({
    id: "edit-sprite-atlas",
    method: "image.edit",
    params: {
      generation_id: "sprite_edit_test_1",
      source_attachment_id: sourceId,
      mode: "atlas_variation",
      prompt: "Replace the armor with polished ice crystal",
      model: "gpt-image-2",
      quality: "high",
      background: "transparent",
      output_format: "png",
      input_fidelity: "high",
      columns: 4,
      rows: 2,
    },
  }));
  await waitFor(() => hasResponse(messages, "edit-sprite-atlas"));
  const response = responseFor(messages, "edit-sprite-atlas") as {
    result: {
      generation_id: string;
      path: string;
      resource_path: string;
      mime_type: string;
      mode: string;
      source_attachment_id: string;
      source_width: number;
      source_height: number;
      output_width: number;
      output_height: number;
      frame_width: number;
      frame_height: number;
      frame_count: number;
      columns: number;
      rows: number;
      transparency_mode: string;
    };
  };
  assert.equal(response.result.generation_id, "sprite_edit_test_1");
  assert.match(response.result.resource_path, /^res:\/\/assets\/generated\/imagex-atlas_variation-.*\.png$/u);
  assert.equal(response.result.mime_type, "image/png");
  assert.equal(response.result.mode, "atlas_variation");
  assert.equal(response.result.source_attachment_id, sourceId);
  assert.deepEqual(
    [response.result.source_width, response.result.source_height, response.result.output_width, response.result.output_height],
    [32, 16, 32, 16],
  );
  assert.deepEqual(
    [response.result.frame_width, response.result.frame_height, response.result.frame_count],
    [8, 8, 8],
  );
  assert.deepEqual([response.result.columns, response.result.rows], [4, 2]);
  assert.equal(response.result.transparency_mode, "chroma_key");

  const provider = instances.at(-1);
  assert.ok(provider);
  assert.equal(provider.imageEditRequests.length, 1);
  const providerRequest = provider.imageEditRequests[0]!;
  assert.equal(providerRequest.inputFidelity, "high");
  assert.equal(providerRequest.background, "opaque");
  const providerInput = PNG.sync.read(Buffer.from(providerRequest.image.bytes));
  assert.deepEqual([providerInput.width, providerInput.height], [32, 32]);
  assert.match(providerRequest.prompt, /Preserve the exact 4x2 grid/u);
  assert.match(providerRequest.prompt, /TECHNICAL CANVAS ADAPTER/u);
  assert.match(providerRequest.prompt, /#00FF00/u);
  const storedImage = await readFile(path.join(root, ...response.result.path.split("/")));
  assert.deepEqual([PNG.sync.read(storedImage).width, PNG.sync.read(storedImage).height], [32, 16]);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  socket.send(JSON.stringify({
    id: "edit-single-sprite",
    method: "image.edit",
    params: {
      generation_id: "sprite_edit_test_reskin",
      source_attachment_id: sourceId,
      mode: "reskin",
      prompt: "Replace the armor with polished copper",
      model: "gpt-image-2",
      quality: "high",
      background: "transparent",
      output_format: "png",
      input_fidelity: "high",
    },
  }));
  await waitFor(() => hasResponse(messages, "edit-single-sprite"));
  const reskinResponse = responseFor(messages, "edit-single-sprite") as {
    result: {
      generation_id: string;
      path: string;
      resource_path: string;
      mode: string;
      output_width: number;
      output_height: number;
    };
  };
  assert.equal(reskinResponse.result.generation_id, "sprite_edit_test_reskin");
  assert.equal(reskinResponse.result.mode, "reskin");
  assert.equal(reskinResponse.result.resource_path, `res://${reskinResponse.result.path}`);
  assert.match(reskinResponse.result.resource_path, /^res:\/\/assets\/generated\/imagex-reskin-.*\.png$/u);
  assert.deepEqual(
    [reskinResponse.result.output_width, reskinResponse.result.output_height],
    [32, 16],
  );
  const storedReskin = await readFile(path.join(root, ...reskinResponse.result.path.split("/")));
  assert.deepEqual([PNG.sync.read(storedReskin).width, PNG.sync.read(storedReskin).height], [32, 16]);
  assert.equal(provider.imageEditRequests.length, 2);

  socket.send(JSON.stringify({
    id: "edit-invalid-atlas",
    method: "image.edit",
    params: {
      generation_id: "sprite_edit_test_2",
      source_attachment_id: invalidId,
      mode: "atlas_variation",
      prompt: "Use a gold palette",
      model: "gpt-image-2",
      columns: 4,
      rows: 2,
    },
  }));
  await waitFor(() => hasResponse(messages, "edit-invalid-atlas"));
  assert.match(responseFor(messages, "edit-invalid-atlas").error?.message ?? "", /evenly divisible/u);
  assert.equal(provider.imageEditRequests.length, 2);

  socket.send(JSON.stringify({
    id: "edit-jpeg-sprite",
    method: "image.edit",
    params: {
      generation_id: "sprite_edit_test_3",
      source_attachment_id: jpegId,
      mode: "reskin",
      prompt: "Use a blue palette",
      model: "gpt-image-2",
    },
  }));
  await waitFor(() => hasResponse(messages, "edit-jpeg-sprite"));
  assert.match(responseFor(messages, "edit-jpeg-sprite").error?.message ?? "", /requires a PNG source/u);
  assert.equal(provider.imageEditRequests.length, 2);
});

test("server cancels an active sprite edit without writing an artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-sprite-edit-cancel-"));
  const attachmentStore = AttachmentStore.forWorkspace(root);
  const sourceBytes = makeTransparentGeneratedPng(32, 16);
  const sourceId = createHash("sha256").update(sourceBytes).digest("hex");
  await writeFile(path.join(attachmentStore.directory, `${sourceId}.png`), sourceBytes);

  const instances: TestProvider[] = [];
  const token = "sprite-edit-cancel-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry: new ProviderRegistry([testProviderDefinition(instances)]),
    attachmentStore,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-sprite-edit-cancel",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "slow-image-edit" },
      model: "gpt-image-2",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-sprite-edit-cancel"));
  const provider = instances.at(-1);
  assert.ok(provider);

  const generationId = "sprite_edit_cancel_1";
  socket.send(JSON.stringify({
    id: "edit-sprite-to-cancel",
    method: "image.edit",
    params: {
      generation_id: generationId,
      source_attachment_id: sourceId,
      mode: "reskin",
      prompt: "Replace the armor with polished ice crystal",
      model: "gpt-image-2",
      size: "1024x1024",
      background: "transparent",
      output_format: "png",
    },
  }));
  await waitFor(() => provider.imageEditStarted);

  socket.send(JSON.stringify({
    id: "cancel-sprite-edit",
    method: "image.cancel",
    params: { generation_id: generationId },
  }));
  await waitFor(() => hasResponse(messages, "cancel-sprite-edit"));
  await waitFor(() => hasResponse(messages, "edit-sprite-to-cancel"));

  assert.deepEqual(responseFor(messages, "cancel-sprite-edit").result, {
    generation_id: generationId,
    cancelled: true,
  });
  assert.match(
    responseFor(messages, "edit-sprite-to-cancel").error?.message ?? "",
    /Image edit was cancelled/u,
  );
  assert.equal(provider.imageEditAborted, true);
  const generatedFiles = await readdir(path.join(root, "assets", "generated")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  assert.deepEqual(generatedFiles, []);
});

test("server streams UI kit progress and returns bounded artifact metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-ui-kit-server-"));
  const provider = new UiKitServerProvider();
  const providerRegistry = new ProviderRegistry([uiKitProviderDefinition(provider)]);
  const token = "ui-kit-provider-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);
  socket.send(JSON.stringify({
    id: "configure-ui-kit",
    method: "configure",
    params: { provider_id: "ui-kit-provider", provider_config: {}, model: "planner-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-ui-kit"));
  socket.send(JSON.stringify({
    id: "generate-ui-kit",
    method: "ui_kit.generate",
    params: {
      workflow_id: "workflow_server_1",
      prompt: "Create a pause menu kit",
      planner_model: "planner-model",
      image_model: "image-model",
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
      max_assets: 2,
      review_enabled: true,
      context: { scene_path: "res://menu.tscn" },
      target_width: 96,
      target_height: 48,
    },
  }));
  await waitFor(() => hasResponse(messages, "generate-ui-kit"));
  const progressPhases = messages
    .filter((message) => (message as { event?: { type?: string } }).event?.type === "asset.progress")
    .map((message) => (message as { event: { data: { phase: string } } }).event.data.phase);
  assert.deepEqual(progressPhases, ["planning", "planned", "generating", "generating", "reviewing", "completed"]);
  const response = responseFor(messages, "generate-ui-kit") as {
    result: {
      workflow_id: string;
      assets: Array<{
        resource_path: string;
        byte_size: number;
        transparency_mode: string;
        normalized: boolean;
        output_width: number;
        output_height: number;
      }>;
      review: { status: string; passed: boolean; score: number };
    };
  };
  assert.equal(response.result.workflow_id, "workflow_server_1");
  assert.equal(response.result.assets.length, 2);
  assert.ok(response.result.assets.every((asset) => asset.resource_path.startsWith("res://assets/generated/ui-kits/")));
  assert.ok(response.result.assets.every((asset) => asset.transparency_mode === "native" && asset.normalized));
  assert.ok(response.result.assets.every((asset) => asset.output_width === 96 && asset.output_height === 48));
  assert.deepEqual(response.result.review, {
    status: "completed",
    passed: true,
    score: 92,
    summary: "Consistent kit",
    issues: [],
  });
  assert.equal(JSON.stringify(response).includes("iVBOR"), false);
});

test("server selects injected providers and isolates stale model requests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-provider-server-"));
  const instances: TestProvider[] = [];
  const providerRegistry = new ProviderRegistry([testProviderDefinition(instances)]);
  const token = "provider-test-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({ id: "providers", method: "providers.list", params: {} }));
  await waitFor(() => hasResponse(messages, "providers"));
  const providerList = responseFor(messages, "providers") as {
    result: { providers: Array<{ id: string; default_model?: string }> };
  };
  assert.deepEqual(providerList.result.providers, [
    {
      id: "test-provider",
      display_name: "Test provider",
      default_model: "test-default",
      config_fields: [
        { key: "name", label: "Instance", type: "text", required: true },
      ],
    },
  ]);

  socket.send(JSON.stringify({
    id: "configure-slow",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "slow" },
      model: "slow-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-slow"));
  socket.send(JSON.stringify({ id: "slow-models", method: "models.list", params: {} }));
  await waitFor(() => instances[0]?.listStarted === true);

  socket.send(JSON.stringify({
    id: "configure-fast",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "fast" },
      model: "fast-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-fast"));
  await waitFor(() => hasResponse(messages, "slow-models"));
  assert.match(responseFor(messages, "slow-models").error?.message ?? "", /aborted|changed/i);
  assert.equal(instances[0]?.disposeCalls, 1);

  socket.send(JSON.stringify({ id: "fast-models", method: "models.list", params: {} }));
  await waitFor(() => hasResponse(messages, "fast-models"));
  const fastModels = responseFor(messages, "fast-models") as { result: { models: ProviderModel[] } };
  assert.deepEqual(fastModels.result.models[0], {
    id: "fast-model",
    capabilities: TEST_MODEL_CAPABILITIES,
  });

  socket.send(JSON.stringify({ id: "session", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session"));
  const sessionId = String((responseFor(messages, "session").result as { session_id?: string }).session_id ?? "");
  socket.send(JSON.stringify({
    id: "turn",
    method: "turn.start",
    params: { session_id: sessionId, prompt: "HI", reasoning_effort: "none" },
  }));
  await waitFor(() => hasResponse(messages, "turn"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string; session_id?: string } }
  ).event?.type === "turn.completed"));
  assert.ok(messages.some((message) => (message as { event?: { type?: string } }).event?.type === "reasoning.summary.delta"));
  assert.ok(messages.some((message) => (message as { event?: { type?: string } }).event?.type === "message.delta"));

  socket.send(JSON.stringify({
    id: "mixed",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "mixed" },
      base_url: "https://example.invalid/v1",
      api_key: "secret-that-must-not-leak",
      model: "test",
    },
  }));
  await waitFor(() => hasResponse(messages, "mixed"));
  assert.match(responseFor(messages, "mixed").error?.message ?? "", /Do not mix/);
  assert.doesNotMatch(JSON.stringify(responseFor(messages, "mixed")), /secret-that-must-not-leak/);

  socket.send(JSON.stringify({
    id: "unknown",
    method: "configure",
    params: { provider_id: "missing", provider_config: {}, model: "test" },
  }));
  await waitFor(() => hasResponse(messages, "unknown"));
  assert.match(responseFor(messages, "unknown").error?.message ?? "", /Unknown provider/);
});

test("server bridges editor tool calls through version-one events and client responses", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-editor-bridge-server-"));
  const provider = new EditorCallingProvider();
  const providerRegistry = new ProviderRegistry([editorCallingProviderDefinition(provider)]);
  const token = "editor-bridge-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure",
    method: "configure",
    params: { provider_id: "editor-calling", provider_config: {}, model: "editor-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure"));
  socket.send(JSON.stringify({ id: "session", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session"));
  const sessionId = String((responseFor(messages, "session").result as { session_id?: string }).session_id ?? "");
  socket.send(JSON.stringify({
    id: "turn",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Inspect the editor scene",
      scene_leases: [{
        scene_id: "scene-live-read",
        scene_path: "res://demo/read.tscn",
        scene_revision: "revision-read-1",
      }],
      primary_scene_id: "scene-live-read",
      open_scene_paths: ["res://demo/read.tscn"],
    },
  }));
  await waitFor(() => hasResponse(messages, "turn"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request"));
  const editorEvent = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request") as {
    event: {
      version: number;
      session_id?: string;
      turn_id?: string;
      item_id?: string;
      data: {
        request_id: string;
        tool: string;
        arguments: Record<string, unknown>;
        scene_lease: { scene_id: string; scene_path: string; scene_revision: string };
      };
    };
  };
  assert.equal(editorEvent.event.version, 1);
  assert.equal(editorEvent.event.session_id, sessionId);
  assert.match(editorEvent.event.turn_id ?? "", /^turn_/);
  assert.match(editorEvent.event.item_id ?? "", /^item_/);
  assert.deepEqual(editorEvent.event.data, {
    request_id: editorEvent.event.data.request_id,
    tool: "scene_get_tree",
    arguments: {
      scene_id: "scene-live-read",
      max_depth: 6,
      max_nodes: 200,
      include_internal: false,
    },
    scene_lease: {
      scene_id: "scene-live-read",
      scene_path: "res://demo/read.tscn",
      scene_revision: "revision-read-1",
    },
  });

  socket.send(JSON.stringify({
    id: "editor-response",
    method: "editor.tool.respond",
    params: {
      request_id: editorEvent.event.data.request_id,
      result: {
        ok: true,
        scene_id: "scene-live-read",
        scene_path: "res://demo/read.tscn",
        scene_revision: "revision-read-1",
        root: { name: "Main", type: "Node" },
      },
    },
  }));
  await waitFor(() => hasResponse(messages, "editor-response"));
  assert.deepEqual(responseFor(messages, "editor-response").result, {
    resolved: true,
    request_id: editorEvent.event.data.request_id,
  });
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed"));
  assert.deepEqual(provider.toolResult, {
    ok: true,
    scene_id: "scene-live-read",
    scene_path: "res://demo/read.tscn",
    scene_revision: "revision-read-1",
    root: { name: "Main", type: "Node" },
  });

  socket.send(JSON.stringify({
    id: "editor-duplicate",
    method: "editor.tool.respond",
    params: { request_id: editorEvent.event.data.request_id, result: { ok: true } },
  }));
  await waitFor(() => hasResponse(messages, "editor-duplicate"));
  assert.equal(responseFor(messages, "editor-duplicate").error?.code, "EDITOR_REQUEST_ALREADY_RESOLVED");
});

test("server ignores a current-mode scene_path and freezes the target before approval", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-game-debug-server-"));
  const provider = new GameDebugProvider();
  const providerRegistry = new ProviderRegistry([gameDebugProviderDefinition(provider)]);
  const token = "game-debug-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-game-debug",
    method: "configure",
    params: { provider_id: "game-debug", provider_config: {}, model: "game-debug-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-game-debug"));
  socket.send(JSON.stringify({ id: "session-game-debug", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session-game-debug"));
  const sessionId = String(
    (responseFor(messages, "session-game-debug").result as { session_id?: string }).session_id ?? "",
  );
  socket.send(JSON.stringify({
    id: "turn-game-debug",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Run the project and inspect its debug output",
      scene_leases: [{
        scene_id: "scene-game-debug-current",
        scene_path: "res://demo/current.tscn",
        scene_revision: "revision-game-debug-current",
      }],
      primary_scene_id: "scene-game-debug-current",
      open_scene_paths: ["res://demo/current.tscn"],
    },
  }));
  await waitFor(() => hasResponse(messages, "turn-game-debug"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested"));

  const approval = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested") as {
    event: {
      session_id?: string;
      turn_id?: string;
      item_id?: string;
      data: {
        request_id: string;
        category: string;
        tool: string;
        arguments: Record<string, unknown>;
      };
    };
  };
  assert.equal(approval.event.session_id, sessionId);
  assert.match(approval.event.turn_id ?? "", /^turn_/);
  assert.match(approval.event.item_id ?? "", /^item_/);
  assert.equal(approval.event.data.category, "editor_game");
  assert.equal(approval.event.data.tool, "game_debug_start");
  assert.deepEqual(approval.event.data.arguments, {
    mode: "scene",
    scene_path: "res://demo/current.tscn",
  });
  assert.equal(messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request"), false);

  socket.send(JSON.stringify({
    id: "approve-game-debug",
    method: "approval.respond",
    params: { request_id: approval.event.data.request_id, decision: "accept" },
  }));
  await waitFor(() => hasResponse(messages, "approve-game-debug"));
  await waitFor(() => editorToolRequests(messages).length >= 1);

  const startRequest = editorToolRequests(messages)[0]!;
  assert.equal(startRequest.event.session_id, sessionId);
  assert.equal(startRequest.event.data.tool, "game_debug_start");
  assert.deepEqual(startRequest.event.data.arguments, {
    mode: "scene",
    scene_path: "res://demo/current.tscn",
  });
  assert.equal(Object.hasOwn(startRequest.event.data, "scene_lease"), false);
  const startResult = {
    ok: true,
    run_id: GameDebugProvider.RUN_ID,
    mode: "scene",
    launch_requested: true,
  };
  socket.send(JSON.stringify({
    id: "game-debug-start-response",
    method: "editor.tool.respond",
    params: { request_id: startRequest.event.data.request_id, result: startResult },
  }));
  await waitFor(() => hasResponse(messages, "game-debug-start-response"));
  await waitFor(() => editorToolRequests(messages).length >= 2);

  const statusRequest = editorToolRequests(messages)[1]!;
  assert.equal(statusRequest.event.data.tool, "game_debug_status");
  assert.deepEqual(statusRequest.event.data.arguments, { history_limit: 50, after_seq: 7 });
  assert.equal(Object.hasOwn(statusRequest.event.data, "scene_lease"), false);
  const statusResult = {
    ok: true,
    run_id: GameDebugProvider.RUN_ID,
    owned: true,
    playing: true,
    next_seq: 9,
    has_more: false,
    entries: [{ seq: 8, level: "info", text: "Game ready" }],
  };
  socket.send(JSON.stringify({
    id: "game-debug-status-response",
    method: "editor.tool.respond",
    params: { request_id: statusRequest.event.data.request_id, result: statusResult },
  }));
  await waitFor(() => hasResponse(messages, "game-debug-status-response"));
  await waitFor(() => editorToolRequests(messages).length >= 3);

  const stopRequest = editorToolRequests(messages)[2]!;
  assert.equal(stopRequest.event.data.tool, "game_debug_stop");
  assert.deepEqual(stopRequest.event.data.arguments, { run_id: GameDebugProvider.RUN_ID });
  assert.equal(Object.hasOwn(stopRequest.event.data, "scene_lease"), false);
  const stopResult = {
    ok: true,
    run_id: GameDebugProvider.RUN_ID,
    stop_requested: true,
  };
  socket.send(JSON.stringify({
    id: "game-debug-stop-response",
    method: "editor.tool.respond",
    params: { request_id: stopRequest.event.data.request_id, result: stopResult },
  }));
  await waitFor(() => hasResponse(messages, "game-debug-stop-response"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed"));

  assert.deepEqual(provider.toolResults, [startResult, statusResult, stopResult]);
  const eventTypes = messages.flatMap((message) => {
    const type = (message as { event?: { type?: string } }).event?.type;
    return type ? [type] : [];
  });
  assert.ok(eventTypes.indexOf("approval.requested") < eventTypes.indexOf("approval.resolved"));
  assert.ok(eventTypes.indexOf("approval.resolved") < eventTypes.indexOf("editor.tool.request"));
  assert.ok(eventTypes.lastIndexOf("editor.tool.request") < eventTypes.indexOf("turn.completed"));
});

test("server ignores a main-mode scene_path before strict scene-path validation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-game-debug-main-server-"));
  const provider = new MainGameDebugStartProvider();
  const providerRegistry = new ProviderRegistry([gameDebugProviderDefinition(provider)]);
  const token = "game-debug-main-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-game-debug-main",
    method: "configure",
    params: { provider_id: "game-debug", provider_config: {}, model: "game-debug-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-game-debug-main"));
  socket.send(JSON.stringify({ id: "session-game-debug-main", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session-game-debug-main"));
  const sessionId = String(
    (responseFor(messages, "session-game-debug-main").result as { session_id?: string }).session_id ?? "",
  );
  socket.send(JSON.stringify({
    id: "turn-game-debug-main",
    method: "turn.start",
    params: { session_id: sessionId, prompt: "Run the project entry point" },
  }));
  await waitFor(() => hasResponse(messages, "turn-game-debug-main"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested"));

  const approval = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested") as {
    event: { data: { request_id: string; arguments: Record<string, unknown> } };
  };
  assert.deepEqual(approval.event.data.arguments, { mode: "main" });
  socket.send(JSON.stringify({
    id: "approve-game-debug-main",
    method: "approval.respond",
    params: { request_id: approval.event.data.request_id, decision: "accept" },
  }));
  await waitFor(() => hasResponse(messages, "approve-game-debug-main"));
  await waitFor(() => editorToolRequests(messages).length >= 1);

  const startRequest = editorToolRequests(messages)[0]!;
  assert.equal(startRequest.event.data.tool, "game_debug_start");
  assert.deepEqual(startRequest.event.data.arguments, { mode: "main" });
  const startResult = {
    ok: true,
    run_id: GameDebugProvider.RUN_ID,
    mode: "main",
    launch_requested: true,
  };
  socket.send(JSON.stringify({
    id: "game-debug-main-response",
    method: "editor.tool.respond",
    params: { request_id: startRequest.event.data.request_id, result: startResult },
  }));
  await waitFor(() => hasResponse(messages, "game-debug-main-response"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed"));
  assert.deepEqual(provider.toolResult, startResult);
});

test("server forwards enabled runtime automation as one bounded WebSocket plan", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-game-automation-server-"));
  const provider = new GameAutomationProvider();
  const providerRegistry = new ProviderRegistry([gameAutomationProviderDefinition(provider)]);
  const token = "game-automation-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-automation",
    method: "configure",
    params: { provider_id: "game-automation", provider_config: {}, model: "game-automation-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-automation"));
  socket.send(JSON.stringify({ id: "session-automation", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session-automation"));
  const sessionId = String(
    (responseFor(messages, "session-automation").result as { session_id?: string }).session_id ?? "",
  );

  socket.send(JSON.stringify({
    id: "invalid-automation-switch",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Run UI automation",
      runtime_automation_enabled: "yes",
    },
  }));
  await waitFor(() => hasResponse(messages, "invalid-automation-switch"));
  assert.match(
    responseFor(messages, "invalid-automation-switch").error?.message ?? "",
    /runtime_automation_enabled must be a boolean/,
  );

  socket.send(JSON.stringify({
    id: "turn-automation",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Run UI automation",
      runtime_automation_enabled: true,
    },
  }));
  await waitFor(() => hasResponse(messages, "turn-automation"));
  await waitFor(() => editorToolRequests(messages).length >= 1);
  const turnStarted = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.started") as {
    event: { data: { runtime_automation_enabled?: boolean } };
  };
  assert.equal(turnStarted.event.data.runtime_automation_enabled, true);
  assert.equal(messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested"), false);

  const runRequest = editorToolRequests(messages)[0]!;
  assert.equal(runRequest.event.data.tool, "game_automation_run");
  assert.equal(Object.hasOwn(runRequest.event.data, "scene_lease"), false);
  assert.deepEqual(runRequest.event.data.arguments, {
    run_id: GameAutomationProvider.RUN_ID,
    steps: [
      { type: "click_control", node_path: "HUD/Start", button: 1 },
      {
        type: "assert_node",
        node_path: "HUD/Result",
        check: "property_equals",
        property: "text",
        value: "Ready",
        timeout_frames: 120,
      },
    ],
    stop_on_failure: true,
  });
  const runResult = {
    ok: true,
    run_id: GameAutomationProvider.RUN_ID,
    automation_id: GameAutomationProvider.AUTOMATION_ID,
    status: "queued",
  };
  socket.send(JSON.stringify({
    id: "automation-run-response",
    method: "editor.tool.respond",
    params: { request_id: runRequest.event.data.request_id, result: runResult },
  }));
  await waitFor(() => hasResponse(messages, "automation-run-response"));
  await waitFor(() => editorToolRequests(messages).length >= 2);

  const statusRequest = editorToolRequests(messages)[1]!;
  assert.equal(statusRequest.event.data.tool, "game_automation_status");
  assert.deepEqual(statusRequest.event.data.arguments, {
    run_id: GameAutomationProvider.RUN_ID,
    automation_id: GameAutomationProvider.AUTOMATION_ID,
  });
  const statusResult = {
    ok: true,
    run_id: GameAutomationProvider.RUN_ID,
    automation_id: GameAutomationProvider.AUTOMATION_ID,
    status: "completed",
    completed_steps: 2,
  };
  socket.send(JSON.stringify({
    id: "automation-status-response",
    method: "editor.tool.respond",
    params: { request_id: statusRequest.event.data.request_id, result: statusResult },
  }));
  await waitFor(() => hasResponse(messages, "automation-status-response"));
  await waitFor(() => editorToolRequests(messages).length >= 3);

  const cancelRequest = editorToolRequests(messages)[2]!;
  assert.equal(cancelRequest.event.data.tool, "game_automation_cancel");
  assert.deepEqual(cancelRequest.event.data.arguments, {
    run_id: GameAutomationProvider.RUN_ID,
    automation_id: GameAutomationProvider.AUTOMATION_ID,
  });
  const cancelResult = {
    ok: true,
    run_id: GameAutomationProvider.RUN_ID,
    automation_id: GameAutomationProvider.AUTOMATION_ID,
    status: "completed",
    cancel_requested: false,
  };
  socket.send(JSON.stringify({
    id: "automation-cancel-response",
    method: "editor.tool.respond",
    params: { request_id: cancelRequest.event.data.request_id, result: cancelResult },
  }));
  await waitFor(() => hasResponse(messages, "automation-cancel-response"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed"));

  assert.deepEqual(provider.toolResults, [runResult, statusResult, cancelResult]);
});

test("server completes one composite game_test workflow with two model turns", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-game-test-server-"));
  const provider = new GameTestProvider();
  const providerRegistry = new ProviderRegistry([gameTestProviderDefinition(provider)]);
  const token = "game-test-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-game-test",
    method: "configure",
    params: { provider_id: "game-test", provider_config: {}, model: "game-test-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-game-test"));
  socket.send(JSON.stringify({ id: "session-game-test", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session-game-test"));
  const sessionId = String(
    (responseFor(messages, "session-game-test").result as { session_id?: string }).session_id ?? "",
  );

  socket.send(JSON.stringify({
    id: "turn-game-test",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Verify the current game locally",
      runtime_automation_enabled: true,
      scene_leases: [{
        scene_id: "scene-game-test",
        scene_path: "res://demo/main.tscn",
        scene_revision: "revision-game-test",
      }],
      primary_scene_id: "scene-game-test",
      open_scene_paths: ["res://demo/main.tscn"],
    },
  }));
  await waitFor(() => hasResponse(messages, "turn-game-test"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.started"));
  const gameTestTurnStarted = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.started") as {
    event: {
      data: {
        tool_profile?: string;
        tool_names?: string[];
        tool_count?: number;
        tool_schema_bytes?: number;
        full_tool_schema_bytes?: number;
      };
    };
  };
  assert.equal(gameTestTurnStarted.event.data.tool_profile, "game");
  assert.deepEqual(gameTestTurnStarted.event.data.tool_names, [
    "list_files",
    "read_file",
    "search_text",
    "game_test",
  ]);
  assert.equal(gameTestTurnStarted.event.data.tool_count, 4);
  assert.ok(
    Number(gameTestTurnStarted.event.data.tool_schema_bytes) <
    Number(gameTestTurnStarted.event.data.full_tool_schema_bytes),
  );
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested"));

  const approval = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested") as {
    event: { data: { request_id: string; category: string; arguments: Record<string, unknown> } };
  };
  assert.equal(approval.event.data.category, "editor_game");
  assert.deepEqual(approval.event.data.arguments, {
    mode: "scene",
    scene_path: "res://demo/main.tscn",
  });
  socket.send(JSON.stringify({
    id: "approve-game-test",
    method: "approval.respond",
    params: { request_id: approval.event.data.request_id, decision: "accept" },
  }));
  await waitFor(() => hasResponse(messages, "approve-game-test"));

  let handledRequests = 0;
  let debugReads = 0;
  let stopRequested = false;
  while (!messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed")) {
    await waitFor(() => (
      editorToolRequests(messages).length > handledRequests ||
      messages.some((message) => (
        message as { event?: { type?: string } }
      ).event?.type === "turn.completed")
    ));
    const request = editorToolRequests(messages)[handledRequests];
    if (!request) continue;
    handledRequests += 1;
    const tool = request.event.data.tool;
    let result: Record<string, unknown>;
    if (tool === "game_debug_start") {
      result = { ok: true, run_id: GameTestProvider.RUN_ID, launch_requested: true };
    } else if (tool === "game_debug_status") {
      debugReads += 1;
      result = {
        ok: true,
        run_id: GameTestProvider.RUN_ID,
        owned: !stopRequested,
        playing: !stopRequested,
        launch_observed: true,
        probe_confirmed: true,
        next_seq: debugReads,
        has_more: false,
        entries: stopRequested ? [] : [{ seq: debugReads, level: "info", text: "game-test-log" }],
      };
    } else if (tool === "game_automation_run") {
      result = {
        ok: true,
        run_id: GameTestProvider.RUN_ID,
        automation_id: GameTestProvider.AUTOMATION_ID,
        state: "queued",
      };
    } else if (tool === "game_automation_status") {
      result = {
        ok: true,
        run_id: GameTestProvider.RUN_ID,
        automation_id: GameTestProvider.AUTOMATION_ID,
        state: "passed",
        current_step: 1,
        step_count: 1,
        results: [{ index: 0, type: "assert_node", state: "passed", message: "Root exists" }],
      };
    } else if (tool === "game_debug_stop") {
      stopRequested = true;
      result = { ok: true, run_id: GameTestProvider.RUN_ID, stop_requested: true };
    } else {
      assert.fail(`Unexpected composite editor request: ${tool}`);
    }
    const responseId = `game-test-editor-response-${handledRequests}`;
    socket.send(JSON.stringify({
      id: responseId,
      method: "editor.tool.respond",
      params: { request_id: request.event.data.request_id, result },
    }));
    await waitFor(() => hasResponse(messages, responseId));
  }

  assert.equal(provider.calls, 2);
  assert.equal(provider.toolResult?.ok, true);
  assert.equal(provider.toolResult?.state, "passed");
  assert.equal(provider.toolResult?.stopped, true);
  assert.deepEqual(editorToolRequests(messages).map((request) => request.event.data.tool), [
    "game_debug_start",
    "game_debug_status",
    "game_automation_run",
    "game_automation_status",
    "game_debug_status",
    "game_debug_stop",
    "game_debug_status",
  ]);
  const phases = messages.flatMap((message) => {
    const event = (message as { event?: { type?: string; data?: { phase?: string } } }).event;
    return event?.type === "tool.output.delta" && event.data?.phase ? [event.data.phase] : [];
  });
  assert.deepEqual([...new Set(phases)], [
    "validating",
    "starting",
    "waiting_for_probe",
    "running_automation",
    "cleaning_up",
    "completed",
  ]);
});

test("server approves and applies live editor scene writes through the complete WebSocket chain", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-editor-write-server-"));
  const provider = new EditorSceneWritingProvider();
  const providerRegistry = new ProviderRegistry([editorSceneWritingProviderDefinition(provider)]);
  const token = "editor-write-capability";
  const server = await startServer({
    workspace: root,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());
  await waitFor(() => messages.length >= 1);

  socket.send(JSON.stringify({
    id: "configure-write",
    method: "configure",
    params: { provider_id: "editor-scene-writing", provider_config: {}, model: "editor-model" },
  }));
  await waitFor(() => hasResponse(messages, "configure-write"));
  socket.send(JSON.stringify({ id: "session-write", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "session-write"));
  const sessionId = String(
    (responseFor(messages, "session-write").result as { session_id?: string }).session_id ?? "",
  );
  socket.send(JSON.stringify({
    id: "turn-write",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Change the live title",
      scene_leases: [{
        scene_id: "scene-live-42",
        scene_path: "res://demo/live-42.tscn",
        scene_revision: "revision-4",
      }],
      primary_scene_id: "scene-live-42",
      open_scene_paths: ["res://demo/live-42.tscn"],
    },
  }));
  await waitFor(() => hasResponse(messages, "turn-write"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested"));

  const proposed = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor_change.proposed") as {
    event: {
      version: number;
      session_id?: string;
      data: {
        change_id: string;
        scene_id: string;
        scene_path: string;
        scene_revision: string;
        changes: unknown[];
        preview: { scene_id: string; scene_path: string; scene_revision: string; changes: unknown[] };
      };
    };
  };
  const approval = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "approval.requested") as {
    event: {
      data: {
        request_id: string;
        category: string;
        change_id: string;
        preview: { scene_id: string; scene_path: string; scene_revision: string; changes: unknown[] };
      };
    };
  };
  assert.equal(proposed.event.version, 1);
  assert.equal(proposed.event.session_id, sessionId);
  assert.equal(proposed.event.data.scene_id, "scene-live-42");
  assert.equal(proposed.event.data.scene_path, "res://demo/live-42.tscn");
  assert.equal(proposed.event.data.scene_revision, "revision-4");
  assert.deepEqual(proposed.event.data.changes, EditorSceneWritingProvider.OPERATIONS);
  assert.deepEqual(proposed.event.data.preview, {
    scene_id: "scene-live-42",
    scene_path: "res://demo/live-42.tscn",
    scene_revision: "revision-4",
    changes: EditorSceneWritingProvider.OPERATIONS,
  });
  assert.equal(approval.event.data.category, "editor_scene");
  assert.equal(approval.event.data.change_id, proposed.event.data.change_id);
  assert.deepEqual(approval.event.data.preview, proposed.event.data.preview);
  assert.equal(messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request"), false);

  socket.send(JSON.stringify({
    id: "approve-write",
    method: "approval.respond",
    params: { request_id: approval.event.data.request_id, decision: "accept" },
  }));
  await waitFor(() => hasResponse(messages, "approve-write"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request"));
  const editorRequest = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request") as {
    event: {
      data: {
        request_id: string;
        tool: string;
        arguments: Record<string, unknown>;
        scene_lease: { scene_id: string; scene_path: string; scene_revision: string };
      };
    };
  };
  assert.equal(editorRequest.event.data.tool, "scene_apply_operations");
  assert.deepEqual(editorRequest.event.data.arguments.scene_id, "scene-live-42");
  assert.deepEqual(editorRequest.event.data.arguments.scene_revision, "revision-4");
  assert.deepEqual(editorRequest.event.data.arguments.operations, EditorSceneWritingProvider.OPERATIONS);
  assert.equal(editorRequest.event.data.arguments.operation_id, proposed.event.data.change_id);
  assert.match(String(editorRequest.event.data.arguments.operation_id), /^editor_operation_[0-9a-f]{64}$/);
  assert.deepEqual(editorRequest.event.data.scene_lease, {
    scene_id: "scene-live-42",
    scene_path: "res://demo/live-42.tscn",
    scene_revision: "revision-4",
  });

  socket.send(JSON.stringify({
    id: "editor-write-response",
    method: "editor.tool.respond",
    params: {
      request_id: editorRequest.event.data.request_id,
      result: {
        ok: true,
        scene_id: "scene-live-42",
        scene_path: "res://demo/live-42.tscn",
        previous_scene_revision: "revision-4",
        scene_revision: "revision-5",
        applied: 1,
        changes: EditorSceneWritingProvider.ACTUAL_CHANGES,
      },
    },
  }));
  await waitFor(() => hasResponse(messages, "editor-write-response"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor_change.applied"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "turn.completed"));

  const applied = messages.find((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor_change.applied") as {
    event: {
      data: {
        change_id: string;
        operation_id: string;
        scene_id: string;
        scene_path: string;
        scene_revision: string;
        previous_scene_revision: string;
        changes: unknown[];
        requested_changes: unknown[];
        result: Record<string, unknown>;
      };
    };
  };
  assert.equal(applied.event.data.change_id, proposed.event.data.change_id);
  assert.equal(applied.event.data.operation_id, proposed.event.data.change_id);
  assert.equal(applied.event.data.scene_id, "scene-live-42");
  assert.equal(applied.event.data.scene_path, "res://demo/live-42.tscn");
  assert.equal(applied.event.data.scene_revision, "revision-5");
  assert.equal(applied.event.data.previous_scene_revision, "revision-4");
  assert.deepEqual(applied.event.data.changes, EditorSceneWritingProvider.ACTUAL_CHANGES);
  assert.deepEqual(applied.event.data.requested_changes, EditorSceneWritingProvider.OPERATIONS);
  const expectedResult = {
    ok: true,
    scene_id: "scene-live-42",
    scene_path: "res://demo/live-42.tscn",
    previous_scene_revision: "revision-4",
    scene_revision: "revision-5",
    applied: 1,
    changes: EditorSceneWritingProvider.ACTUAL_CHANGES,
  };
  assert.deepEqual(applied.event.data.result, expectedResult);
  assert.deepEqual(provider.toolResult, expectedResult);

  const eventTypes = messages.flatMap((message) => {
    const type = (message as { event?: { type?: string } }).event?.type;
    return type ? [type] : [];
  });
  assert.ok(eventTypes.indexOf("editor_change.proposed") < eventTypes.indexOf("approval.requested"));
  assert.ok(eventTypes.indexOf("approval.requested") < eventTypes.indexOf("approval.resolved"));
  assert.ok(eventTypes.indexOf("approval.resolved") < eventTypes.indexOf("editor.tool.request"));
  assert.ok(eventTypes.indexOf("editor.tool.request") < eventTypes.indexOf("editor_change.applied"));
});

test("server exposes durable session list, snapshot, rename, and delete operations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-session-server-"));
  const sessionDirectory = await mkdtemp(path.join(tmpdir(), "godetx-session-server-data-"));
  const sessionStore = new SessionStore(sessionDirectory);
  await writeFile(path.join(sessionDirectory, "session_corrupt00.json"), "{broken", "utf8");
  const instances: TestProvider[] = [];
  const providerRegistry = new ProviderRegistry([testProviderDefinition(instances)]);
  const token = "session-server-capability";
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const server = await startServer({
    workspace: root,
    sessionStore,
    port: 0,
    tokenSha256,
    providerRegistry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.length > 0);

  socket.send(JSON.stringify({
    id: "configure-session-store",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "persistent" },
      model: "persistent-model",
    },
  }));
  await waitFor(() => hasResponse(messages, "configure-session-store"));
  socket.send(JSON.stringify({ id: "create-durable", method: "session.create", params: {} }));
  await waitFor(() => hasResponse(messages, "create-durable"));
  const sessionId = String(
    ((responseFor(messages, "create-durable").result as { session_id?: string })?.session_id ?? ""),
  );
  assert.match(sessionId, /^session_/u);

  socket.send(JSON.stringify({
    id: "turn-durable",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "<godot_editor_context>internal</godot_editor_context>\nVisible prompt",
      display_prompt: "Visible prompt",
    },
  }));
  await waitFor(() => hasResponse(messages, "turn-durable"));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string; session_id?: string } }
  ).event?.type === "turn.completed" && (
    message as { event?: { session_id?: string } }
  ).event?.session_id === sessionId));

  socket.send(JSON.stringify({ id: "list-durable", method: "session.list", params: {} }));
  await waitFor(() => hasResponse(messages, "list-durable"));
  const listed = responseFor(messages, "list-durable").result as {
    sessions: Array<{ session_id: string; title: string; turn_count: number }>;
    diagnostics: Array<{ filename: string; code: string }>;
  };
  assert.deepEqual(listed.sessions.map((session) => session.session_id), [sessionId]);
  assert.equal(listed.sessions[0]?.title, "Visible prompt");
  assert.equal(listed.sessions[0]?.turn_count, 1);
  assert.deepEqual(listed.diagnostics, [{ filename: "session_corrupt00.json", code: "corrupt" }]);

  socket.send(JSON.stringify({
    id: "get-durable",
    method: "session.get",
    params: { session_id: sessionId },
  }));
  await waitFor(() => hasResponse(messages, "get-durable"));
  const snapshot = (responseFor(messages, "get-durable").result as {
    session: {
      turns: Array<{
        prompt: string;
        status: string;
        context?: { history_characters: number; context_characters: number };
        entries: Array<{ kind: string; text?: string }>;
      }>;
    };
  }).session;
  assert.equal(snapshot.turns[0]?.prompt, "Visible prompt");
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.ok((snapshot.turns[0]?.context?.history_characters ?? 0) > 0);
  assert.ok((snapshot.turns[0]?.context?.context_characters ?? 0) > 0);
  assert.deepEqual(snapshot.turns[0]?.entries, [{
    kind: "assistant",
    item_id: snapshot.turns[0]?.entries[0] && (snapshot.turns[0].entries[0] as { item_id?: string }).item_id,
    text: "HI",
    reasoning: "brief thought",
  }]);

  socket.send(JSON.stringify({
    id: "rename-durable",
    method: "session.rename",
    params: { session_id: sessionId, title: "Renamed session" },
  }));
  await waitFor(() => hasResponse(messages, "rename-durable"));
  assert.equal(
    ((responseFor(messages, "rename-durable").result as { session: { title: string } }).session.title),
    "Renamed session",
  );

  socket.send(JSON.stringify({
    id: "delete-durable",
    method: "session.delete",
    params: { session_id: sessionId },
  }));
  await waitFor(() => hasResponse(messages, "delete-durable"));
  assert.equal((responseFor(messages, "delete-durable").result as { deleted: boolean }).deleted, true);
  socket.close();
});

test("turn.start validates shared attachment ids and preserves authoritative image metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-server-image-root-"));
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "godetx-server-image-data-"));
  const attachmentDirectory = path.join(dataDirectory, "godetx", "attachments");
  await mkdir(attachmentDirectory, { recursive: true });
  const image = makeTestPngHeader(640, 360);
  const attachmentId = createHash("sha256").update(image).digest("hex");
  const annotatedFrom = "b".repeat(64);
  const annotations = [
    { id: 1, type: "arrow", start: [0.1, 0.2], end: [0.8, 0.7] },
    { id: 2, type: "rectangle", start: [0, 0], end: [0.5, 0.5] },
  ];
  await writeFile(path.join(attachmentDirectory, `${attachmentId}.png`), image);

  const instances: TestProvider[] = [];
  const registry = new ProviderRegistry([testProviderDefinition(instances)]);
  const token = "attachment-server-token";
  const server = await startServer({
    workspace: root,
    dataDirectory,
    port: 0,
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    providerRegistry: registry,
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${token}`);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(() => messages.length > 0);

  socket.send(JSON.stringify({
    id: "configure-image",
    method: "configure",
    params: {
      provider_id: "test-provider",
      provider_config: { name: "image" },
      model: "image-model",
    },
  }));
  await waitFor(() => Boolean(responseFor(messages, "configure-image")));
  socket.send(JSON.stringify({ id: "create-image", method: "session.create", params: {} }));
  await waitFor(() => Boolean(responseFor(messages, "create-image")));
  const sessionId = (responseFor(messages, "create-image").result as { session_id: string }).session_id;

  socket.send(JSON.stringify({
    id: "get-image",
    method: "attachment.get",
    params: { attachment_id: attachmentId },
  }));
  await waitFor(() => Boolean(responseFor(messages, "get-image")));
  assert.deepEqual(responseFor(messages, "get-image").result, {
    attachment: {
      attachment_id: attachmentId,
      mime_type: "image/png",
      size_bytes: image.byteLength,
      width: 640,
      height: 360,
    },
  });

  socket.send(JSON.stringify({
    id: "turn-image",
    method: "turn.start",
    params: {
      session_id: sessionId,
      prompt: "Inspect this frame",
      attachments: [{
        attachment_id: attachmentId,
        detail: "high",
        annotations,
        annotated_from: annotatedFrom,
        source: "game_frame",
        run_id: "run_12345678",
        scene_id: "scene_12345678",
        scene_path: "res://demo/main.tscn",
        captured_at_ms: 123,
        viewport_width: 640,
        viewport_height: 360,
        frame: 9,
      }],
    },
  }));
  await waitFor(() => Boolean(responseFor(messages, "turn-image")));
  await waitFor(() => messages.some((message) => (
    message as { event?: { type?: string; session_id?: string } }
  ).event?.type === "turn.completed"));
  const request = instances[0]?.requests[0];
  const user = request?.messages.find((message) => message.role === "user");
  assert.equal(user?.role === "user" && Array.isArray(user.content) ? user.content[1]?.type : "", "text");
  assert.match(
    user?.role === "user" && Array.isArray(user.content) && user.content[1]?.type === "text"
      ? user.content[1].text
      : "",
    /#1 arrow .*target=end.*#2 rectangle bbox/u,
  );
  assert.deepEqual(
    user?.role === "user" && Array.isArray(user.content) && user.content[2]?.type === "image"
      ? user.content[2].annotations
      : undefined,
    annotations,
  );

  socket.send(JSON.stringify({
    id: "session-image",
    method: "session.get",
    params: { session_id: sessionId },
  }));
  await waitFor(() => Boolean(responseFor(messages, "session-image")));
  const snapshot = responseFor(messages, "session-image").result as {
    session: { turns: Array<{ attachments?: Array<Record<string, unknown>> }> };
  };
  assert.deepEqual(snapshot.session.turns[0]?.attachments?.[0], {
    attachment_id: attachmentId,
    mime_type: "image/png",
    size_bytes: image.byteLength,
    width: 640,
    height: 360,
    detail: "high",
    annotations,
    annotated_from: annotatedFrom,
    source: "game_frame",
    run_id: "run_12345678",
    scene_id: "scene_12345678",
    scene_path: "res://demo/main.tscn",
    captured_at_ms: 123,
    viewport_width: 640,
    viewport_height: 360,
    frame: 9,
  });
  socket.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for WebSocket message");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const TEST_MODEL_CAPABILITIES: ProviderModelCapabilities = {
  reasoning: { efforts: ["none", "deep"], default_effort: "none" },
};

class TestProvider implements ModelProvider {
  listStarted = false;
  disposeCalls = 0;
  imageEditStarted = false;
  imageEditAborted = false;
  readonly requests: ProviderRequest[] = [];
  readonly imageEditRequests: ImageEditRequest[] = [];

  constructor(readonly name: string) {}

  getModelCapabilities(): ProviderModelCapabilities {
    return TEST_MODEL_CAPABILITIES;
  }

  getImageGenerationCapabilities(): ImageGenerationCapabilities {
    return {
      defaultModel: "gpt-image-2",
      models: ["gpt-image-2"],
      sizes: ["1024x1024"],
      qualities: ["auto", "high"],
      backgrounds: ["auto", "transparent"],
      outputFormats: ["png"],
      maxPromptCharacters: 32_000,
    };
  }

  async listImageModels(): Promise<string[]> {
    return ["gpt-image-1", "gpt-image-1.5", "gpt-image-2"];
  }

  async listImageEditModels(): Promise<string[]> {
    return ["edit-only-model", "gpt-image-1.5", "gpt-image-2"];
  }

  async generateImage(_request: ImageGenerationRequest): Promise<GeneratedImage> {
    return {
      bytes: makeTransparentGeneratedPng(8, 8),
      mimeType: "image/png",
      revisedPrompt: "Refined by test provider",
    };
  }

  async editImage(request: ImageEditRequest): Promise<GeneratedImage> {
    this.imageEditRequests.push(request);
    this.imageEditStarted = true;
    if (this.name === "slow-image-edit") {
      return new Promise<GeneratedImage>((_resolve, reject) => {
        const abort = (): void => {
          this.imageEditAborted = true;
          const error = new Error("Slow image edit aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return {
      bytes: request.prompt.includes("#00FF00")
        ? makeGreenScreenGeneratedPng(8, 8)
        : makeTransparentGeneratedPng(8, 8),
      mimeType: "image/png",
      revisedPrompt: "Edited by test provider",
    };
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    this.listStarted = true;
    if (this.name !== "slow") {
      return [{ id: `${this.name}-model`, capabilities: TEST_MODEL_CAPABILITIES }];
    }
    return new Promise<ProviderModel[]>((_resolve, reject) => {
      const abort = (): void => {
        const error = new Error("Slow provider model request aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.requests.push(request);
    request.onEvent({ type: "reasoning_delta", text: "brief thought" });
    request.onEvent({ type: "text_delta", text: "HI" });
    return { message: { role: "assistant", content: "HI", toolCalls: [] } };
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

class UiKitServerProvider implements ModelProvider {
  calls = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "planner-model" }, { id: "image-model" }];
  }

  getModelCapabilities(): ProviderModelCapabilities {
    return {
      image_input: {
        status: "supported",
        mime_types: ["image/png"],
        detail_levels: ["high"],
        max_images: 4,
      },
    };
  }

  getImageGenerationCapabilities(): ImageGenerationCapabilities {
    return {
      defaultModel: "image-model",
      models: ["image-model"],
      sizes: ["1024x1024"],
      qualities: ["high"],
      backgrounds: ["transparent"],
      outputFormats: ["png"],
      maxPromptCharacters: 32_000,
    };
  }

  async streamTurn(_request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    return {
      message: {
        role: "assistant",
        content: this.calls === 1
          ? JSON.stringify({
              summary: "Pause menu kit",
              style: "clean arcade neon",
              assets: [
                { id: "panel", name: "Panel", role: "panel", prompt: "Pause menu panel" },
                { id: "button", name: "Button", role: "button", prompt: "Reusable button face" },
              ],
            })
          : JSON.stringify({ passed: true, score: 92, summary: "Consistent kit", issues: [] }),
        toolCalls: [],
      },
    };
  }

  async generateImage(_request: ImageGenerationRequest): Promise<GeneratedImage> {
    return {
      bytes: makeTransparentGeneratedPng(8, 8),
      mimeType: "image/png",
    };
  }
}

class EditorCallingProvider implements ModelProvider {
  calls = 0;
  toolResult?: Record<string, unknown>;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "editor-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "editor_call", name: "scene_get_tree", arguments: "{}" }],
        },
      };
    }
    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") {
      this.toolResult = JSON.parse(toolMessage.content) as Record<string, unknown>;
    }
    return { message: { role: "assistant", content: "Scene inspected", toolCalls: [] } };
  }
}

class EditorSceneWritingProvider implements ModelProvider {
  static readonly OPERATIONS = [
    {
      action: "set_property",
      node_path: "HUD/Title",
      property: "text",
      value: "Updated",
    },
  ];
  static readonly ACTUAL_CHANGES = [
    {
      action: "modified",
      node_path: "HUD/Title",
      property: "text",
      old_value: "Old",
      new_value: "Updated",
    },
  ];

  calls = 0;
  toolResult?: Record<string, unknown>;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "editor-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "editor_write_call",
            name: "scene_apply_operations",
            arguments: JSON.stringify({
              scene_id: "scene-live-42",
              operations: EditorSceneWritingProvider.OPERATIONS,
            }),
          }],
        },
      };
    }
    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") {
      this.toolResult = JSON.parse(toolMessage.content) as Record<string, unknown>;
    }
    return { message: { role: "assistant", content: "Scene updated", toolCalls: [] } };
  }
}

class GameDebugProvider implements ModelProvider {
  static readonly RUN_ID = "0123456789abcdef0123456789abcdef";

  calls = 0;
  readonly toolResults: Record<string, unknown>[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "game-debug-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_debug_start_call",
            name: "game_debug_start",
            arguments: JSON.stringify({ mode: "current", scene_path: "/" }),
          }],
        },
      };
    }

    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.ok(toolMessage?.role === "tool");
    const toolResult = JSON.parse(toolMessage.content) as Record<string, unknown>;
    this.toolResults.push(toolResult);

    if (this.calls === 2) {
      assert.equal(toolMessage.name, "game_debug_start");
      assert.equal(toolResult.run_id, GameDebugProvider.RUN_ID);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_debug_status_call",
            name: "game_debug_status",
            arguments: JSON.stringify({ history_limit: 50, after_seq: 7 }),
          }],
        },
      };
    }
    if (this.calls === 3) {
      assert.equal(toolMessage.name, "game_debug_status");
      assert.equal(toolResult.run_id, GameDebugProvider.RUN_ID);
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_debug_stop_call",
            name: "game_debug_stop",
            arguments: JSON.stringify({ run_id: String(toolResult.run_id) }),
          }],
        },
      };
    }

    assert.equal(toolMessage.name, "game_debug_stop");
    assert.equal(toolResult.run_id, GameDebugProvider.RUN_ID);
    return {
      message: { role: "assistant", content: "Game debug run completed", toolCalls: [] },
    };
  }
}

class MainGameDebugStartProvider implements ModelProvider {
  calls = 0;
  toolResult?: Record<string, unknown>;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "game-debug-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_debug_main_start_call",
            name: "game_debug_start",
            arguments: JSON.stringify({ mode: "main", scene_path: "res://../outside.tscn" }),
          }],
        },
      };
    }
    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.ok(toolMessage?.role === "tool");
    assert.equal(toolMessage.name, "game_debug_start");
    this.toolResult = JSON.parse(toolMessage.content) as Record<string, unknown>;
    return { message: { role: "assistant", content: "Project launch requested", toolCalls: [] } };
  }
}

class GameAutomationProvider implements ModelProvider {
  static readonly RUN_ID = "abcdef0123456789abcdef0123456789";
  static readonly AUTOMATION_ID = "automation_abcdef0123456789";

  calls = 0;
  readonly toolResults: Record<string, unknown>[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "game-automation-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    assert.match(request.systemPrompt, /Runtime game automation is enabled for this turn/);
    assert.ok(request.tools.some((tool) => tool.name === "game_automation_run"));
    assert.ok(request.tools.some((tool) => tool.name === "game_automation_status"));
    assert.ok(request.tools.some((tool) => tool.name === "game_automation_cancel"));
    assert.equal(request.tools.some((tool) => tool.name === "game_test"), false);
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_automation_run_call",
            name: "game_automation_run",
            arguments: JSON.stringify({
              run_id: GameAutomationProvider.RUN_ID,
              steps: [
                { type: "click_control", node_path: "HUD/Start" },
                {
                  type: "assert_node",
                  node_path: "HUD/Result",
                  check: "property_equals",
                  property: "text",
                  value: "Ready",
                  timeout_frames: 120,
                },
              ],
            }),
          }],
        },
      };
    }

    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.ok(toolMessage?.role === "tool");
    const result = JSON.parse(toolMessage.content) as Record<string, unknown>;
    this.toolResults.push(result);
    if (this.calls === 2) {
      assert.equal(toolMessage.name, "game_automation_run");
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_automation_status_call",
            name: "game_automation_status",
            arguments: JSON.stringify({
              run_id: GameAutomationProvider.RUN_ID,
              automation_id: GameAutomationProvider.AUTOMATION_ID,
            }),
          }],
        },
      };
    }
    if (this.calls === 3) {
      assert.equal(toolMessage.name, "game_automation_status");
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_automation_cancel_call",
            name: "game_automation_cancel",
            arguments: JSON.stringify({
              run_id: GameAutomationProvider.RUN_ID,
              automation_id: GameAutomationProvider.AUTOMATION_ID,
            }),
          }],
        },
      };
    }
    assert.equal(toolMessage.name, "game_automation_cancel");
    return { message: { role: "assistant", content: "Automation checked", toolCalls: [] } };
  }
}

class GameTestProvider implements ModelProvider {
  static readonly RUN_ID = "13579bdf2468ace013579bdf2468ace0";
  static readonly AUTOMATION_ID = "automation_13579bdf2468ace0";

  calls = 0;
  toolResult?: Record<string, unknown>;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "game-test-model" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    assert.match(request.systemPrompt, /Prefer game_test/);
    assert.deepEqual(request.tools.map((tool) => tool.name), [
      "list_files",
      "read_file",
      "search_text",
      "game_test",
    ]);
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "game_test_call",
            name: "game_test",
            arguments: JSON.stringify({
              target: { mode: "current" },
              steps: [{ type: "assert_node", node_path: ".", check: "exists" }],
              cleanup: "always",
              ready_timeout_ms: 1_000,
              automation_timeout_ms: 1_000,
            }),
          }],
        },
      };
    }

    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.ok(toolMessage?.role === "tool");
    assert.equal(toolMessage.name, "game_test");
    this.toolResult = JSON.parse(toolMessage.content) as Record<string, unknown>;
    return { message: { role: "assistant", content: "Composite game test completed", toolCalls: [] } };
  }
}

function testProviderDefinition(instances: TestProvider[]): ProviderDefinition {
  return {
    id: "test-provider",
    displayName: "Test provider",
    defaultModel: "test-default",
    configSchema: [{ key: "name", label: "Instance", input: "text", required: true }],
    validateConfig(config: unknown): ProviderConfigValidationResult {
      const name = config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>).name
        : undefined;
      return typeof name === "string" && name
        ? { ok: true, value: { name } }
        : { ok: false, issues: [{ field: "name", message: "is required" }] };
    },
    create(config: unknown): ModelProvider {
      const validated = this.validateConfig(config);
      assert.equal(validated.ok, true);
      const provider = new TestProvider(String(validated.ok ? validated.value.name : ""));
      instances.push(provider);
      return provider;
    },
  };
}

function uiKitProviderDefinition(provider: UiKitServerProvider): ProviderDefinition {
  return {
    id: "ui-kit-provider",
    displayName: "UI kit provider",
    defaultModel: "planner-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function editorCallingProviderDefinition(provider: EditorCallingProvider): ProviderDefinition {
  return {
    id: "editor-calling",
    displayName: "Editor calling provider",
    defaultModel: "editor-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function editorSceneWritingProviderDefinition(provider: EditorSceneWritingProvider): ProviderDefinition {
  return {
    id: "editor-scene-writing",
    displayName: "Editor scene writing provider",
    defaultModel: "editor-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function gameDebugProviderDefinition(provider: ModelProvider): ProviderDefinition {
  return {
    id: "game-debug",
    displayName: "Game debug provider",
    defaultModel: "game-debug-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function gameAutomationProviderDefinition(provider: GameAutomationProvider): ProviderDefinition {
  return {
    id: "game-automation",
    displayName: "Game automation provider",
    defaultModel: "game-automation-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function gameTestProviderDefinition(provider: GameTestProvider): ProviderDefinition {
  return {
    id: "game-test",
    displayName: "Game test provider",
    defaultModel: "game-test-model",
    configSchema: [],
    validateConfig(): ProviderConfigValidationResult {
      return { ok: true, value: {} };
    },
    create(): ModelProvider {
      return provider;
    },
  };
}

function editorToolRequests(messages: unknown[]): Array<{
  event: {
    session_id?: string;
    turn_id?: string;
    item_id?: string;
    data: {
      request_id: string;
      tool: string;
      arguments: Record<string, unknown>;
      scene_lease?: unknown;
    };
  };
}> {
  return messages.filter((message) => (
    message as { event?: { type?: string } }
  ).event?.type === "editor.tool.request") as Array<{
    event: {
      session_id?: string;
      turn_id?: string;
      item_id?: string;
      data: {
        request_id: string;
        tool: string;
        arguments: Record<string, unknown>;
        scene_lease?: unknown;
      };
    };
  }>;
}

function hasResponse(messages: unknown[], id: string): boolean {
  return messages.some((message) => (message as { id?: string }).id === id);
}

function responseFor(messages: unknown[], id: string): {
  result?: unknown;
  error?: { code?: string; message?: string; data?: unknown };
} {
  return messages.find((message) => (message as { id?: string }).id === id) as {
    result?: unknown;
    error?: { code?: string; message?: string; data?: unknown };
  };
}

function makeTestPngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function makeTransparentGeneratedPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height, colorType: 6 });
  png.data.fill(0);
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = 220;
      png.data[offset + 1] = 80;
      png.data[offset + 2] = 40;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function makeGreenScreenGeneratedPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const foreground = x >= 2 && x < width - 2 && y >= 2 && y < height - 2;
      png.data[offset] = foreground ? 220 : 0;
      png.data[offset + 1] = foreground ? 80 : 255;
      png.data[offset + 2] = foreground ? 40 : 0;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
