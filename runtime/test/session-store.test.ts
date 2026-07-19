import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compactSessionMessages,
  prepareSessionContext,
  userContentText,
} from "../src/session-context.js";
import {
  SESSION_STORE_SCHEMA_VERSION,
  SessionConflictError,
  SessionStore,
  type PersistedSession,
} from "../src/session-store.js";
import type { AgentMessage } from "../src/provider/types.js";

test("SessionStore atomically round-trips, redacts secrets, and recovers interrupted turns", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-store-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  const session: PersistedSession = {
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_12345678",
    title: "Persistent conversation",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        role: "user",
        content: 'Use sk-1234567890abcdefghijkl safely and {"api_key":"AIza-secret-value","password":"quoted-secret"}',
      },
      {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: JSON.stringify({ api_key: "secret-value" }) }],
      },
      { role: "tool", callId: "call_1", name: "read_file", content: JSON.stringify({ ok: true }) },
    ],
    turns: [{
      id: "turn_12345678",
      prompt: "Persist this task",
      model: "test-model",
      status: "running",
      startedAt: now,
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      entries: [{
        kind: "tool",
        itemId: "item_12345678",
        name: "read_file",
        arguments: { authorization: "Bearer hidden-value-1234567890" },
        output: { ok: true, token: "private-token-value" },
      }],
    }],
  };

  const saved = store.save(session);
  assert.equal(
    store.save({ ...saved, title: "Key sk-1234567890abcdefghijkl" }).title,
    "Key [REDACTED_API_KEY]",
  );
  const redactedTitleSnapshot = store.loadAll()[0]!;
  store.save({ ...redactedTitleSnapshot, title: "Edit res://demo/main.gd and C:\\project\\main.gd" });
  await writeFile(path.join(directory, "session_corrupt00.json"), "{broken", "utf8");

  const loaded = new SessionStore(directory).loadAll();
  assert.equal(loaded.length, 1, "A corrupt sibling file must be isolated");
  assert.equal(loaded[0]?.title, "Edit res://demo/main.gd and C:\\project\\main.gd");
  assert.equal(loaded[0]?.turns[0]?.status, "interrupted");
  assert.ok(loaded[0]?.turns[0]?.completedAt);
  const storedText = await readFile(path.join(directory, "session_12345678.json"), "utf8");
  assert.doesNotMatch(
    storedText,
    /sk-1234567890abcdefghijkl|AIza-secret-value|quoted-secret|secret-value|hidden-value|private-token/u,
  );
  assert.match(storedText, /REDACTED/u);
  const diagnosticStore = new SessionStore(directory);
  diagnosticStore.loadAll();
  assert.deepEqual(diagnosticStore.listDiagnostics(), [{
    filename: "session_corrupt00.json",
    code: "corrupt",
  }]);
  assert.equal(store.delete("session_12345678"), true);
  assert.equal(store.delete("session_12345678"), false);
});

test("SessionStore isolates the same session ID between workspaces", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "godetx-session-data-"));
  const workspaceA = await mkdtemp(path.join(tmpdir(), "godetx-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "godetx-workspace-b-"));
  const now = new Date().toISOString();
  const base: PersistedSession = {
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_same0001",
    title: "A",
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [],
  };
  const storeA = SessionStore.forWorkspace(workspaceA, dataDirectory);
  const storeB = SessionStore.forWorkspace(workspaceB, dataDirectory);
  storeA.save(base);
  storeB.save({ ...base, title: "B" });
  assert.equal(storeA.loadAll()[0]?.title, "A");
  assert.equal(storeB.loadAll()[0]?.title, "B");
});

test("SessionStore round-trips bounded project context entries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-context-entry-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_context01",
    title: "Project context",
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [{
      id: "turn_context01",
      prompt: "Modify player damage",
      model: "test-model",
      status: "completed",
      startedAt: now,
      completedAt: now,
      usage: {},
      entries: [{
        kind: "context",
        itemId: "item_context01",
        data: {
          source_count: 1,
          sources: [{ path: "scripts/player.gd", line: 4, snippet: "func damage(): pass" }],
        },
      }],
    }],
  });

  const entry = new SessionStore(directory).load("session_context01")?.turns[0]?.entries[0];
  assert.equal(entry?.kind, "context");
  assert.deepEqual(entry?.kind === "context" ? entry.data : undefined, {
    source_count: 1,
    sources: [{ path: "scripts/player.gd", line: 4, snippet: "func damage(): pass" }],
  });
});

test("SessionStore retains the latest entries from a long adaptive turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-long-turn-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_longturn1",
    title: "Long adaptive turn",
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [{
      id: "turn_longturn1",
      prompt: "Complete a large task",
      model: "test-model",
      status: "completed",
      startedAt: now,
      completedAt: now,
      usage: {},
      entries: Array.from({ length: 600 }, (_, index) => ({
        kind: "assistant" as const,
        itemId: `item_${index.toString().padStart(8, "0")}`,
        text: `step-${index}`,
        reasoning: "",
      })),
    }],
  });

  const entries = store.load("session_longturn1")?.turns[0]?.entries ?? [];
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  assert.equal(entries.length, 512);
  assert.equal(firstEntry?.kind === "assistant" ? firstEntry.text : "", "step-88");
  assert.equal(lastEntry?.kind === "assistant" ? lastEntry.text : "", "step-599");
});

test("session context compaction retains recent turns and tool call/output pairs", () => {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 8; index += 1) {
    const callId = `call_${index}`;
    messages.push({ role: "user", content: `User request ${index}` });
    messages.push({
      role: "assistant",
      content: `Checking ${index}`,
      toolCalls: [{ id: callId, name: "read_file", arguments: JSON.stringify({ path: `file-${index}.gd` }) }],
    });
    messages.push({
      role: "tool",
      callId,
      name: "read_file",
      content: JSON.stringify({ ok: true, content: "x".repeat(9_000) }),
    });
    messages.push({ role: "assistant", content: `Finished ${index}`, toolCalls: [] });
  }

  const prepared = prepareSessionContext(messages, 24_000);
  assert.equal(prepared.stats.compacted, true);
  assert.ok(prepared.stats.droppedMessages > 0);
  assert.ok(prepared.stats.contextCharacters < prepared.stats.historyCharacters);
  assert.equal(prepared.messages.at(-1)?.role, "assistant");
  assert.match(
    prepared.messages[0]?.role === "user" ? userContentText(prepared.messages[0].content) : "",
    /compacted locally/u,
  );

  for (const [index, message] of prepared.messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      const matchingOutput = prepared.messages.slice(index + 1).find(
        (candidate) => candidate.role === "tool" && candidate.callId === call.id,
      );
      assert.ok(matchingOutput, `Retained tool call ${call.id} must keep its output`);
    }
  }
});

test("session context rejects an oversized current request instead of executing a truncated instruction", () => {
  assert.throws(
    () => prepareSessionContext([{ role: "user", content: "x".repeat(500_000) }], 16_000),
    /Current user request exceeds the safe context budget/u,
  );
});

test("session context compacts editor metadata before the current user request", () => {
  const request = "Change only the requested label. FINAL_INSTRUCTION_MARKER";
  const prepared = prepareSessionContext([{
    role: "user",
    content: `<godot_editor_context>\n${"scene: res://very-long-path.tscn\n".repeat(2_000)}</godot_editor_context>\n\nUser request:\n${request}`,
  }], 16_000);
  const content = prepared.messages[0]?.role === "user" ? userContentText(prepared.messages[0].content) : "";
  assert.ok(prepared.stats.contextCharacters <= 16_000);
  assert.equal(prepared.stats.compacted, true);
  assert.match(content, /\[Content compacted\]/u);
  assert.ok(content.endsWith(request), "The complete current instruction must remain at the end of the message");
});

test("session context keeps current visual observations but omits answered historical images", () => {
  const firstId = "a".repeat(64);
  const observedId = "b".repeat(64);
  const currentId = "c".repeat(64);
  const earlier: AgentMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect the first frame" },
        { type: "image", attachmentId: firstId, mimeType: "image/png", detail: "low" },
      ],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_frame", name: "capture", arguments: "{}" }],
    },
    { role: "tool", callId: "call_frame", name: "capture", content: '{"ok":true}' },
    {
      role: "user",
      synthetic: { kind: "tool_observation", callId: "call_frame" },
      content: [{ type: "image", attachmentId: observedId, mimeType: "image/png", detail: "low" }],
    },
  ];
  const active = prepareSessionContext(earlier, 64_000);
  assert.equal(countImages(active.messages), 2, "current tool observations stay in the active turn segment");

  const answered: AgentMessage[] = [
    ...earlier,
    { role: "assistant", content: "The first frame is complete", toolCalls: [] },
    {
      role: "user",
      content: [
        { type: "text", text: "Now inspect this frame" },
        { type: "image", attachmentId: currentId, mimeType: "image/png", detail: "high" },
      ],
    },
  ];
  const prepared = prepareSessionContext(answered, 64_000);
  assert.equal(countImages(prepared.messages), 1);
  assert.match(
    prepared.messages
      .filter((message) => message.role === "user")
      .map((message) => message.role === "user" ? userContentText(message.content) : "")
      .join("\n"),
    /Historical image/u,
  );
  assert.equal(countImages(compactSessionMessages(answered, 64_000).messages), 3);
});

test("SessionStore persists image references and provenance without embedding image data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-images-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  const attachmentId = "d".repeat(64);
  const annotatedFrom = "e".repeat(64);
  const annotations = [
    { id: 1, type: "arrow" as const, start: [0.1, 0.2] as [number, number], end: [0.8, 0.7] as [number, number] },
    { id: 2, type: "circle" as const, start: [0.2, 0.2] as [number, number], end: [0.4, 0.5] as [number, number] },
  ];
  store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_images001",
    title: "Image session",
    createdAt: now,
    updatedAt: now,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Inspect" },
        { type: "image", attachmentId, mimeType: "image/png", detail: "high", annotations },
      ],
    }],
    turns: [{
      id: "turn_images001",
      prompt: "Inspect",
      model: "gpt-5.6-sol",
      status: "completed",
      startedAt: now,
      completedAt: now,
      attachments: [{
        attachmentId,
        mimeType: "image/png",
        detail: "high",
        annotations,
        annotatedFrom,
        byteSize: 123,
        width: 320,
        height: 180,
        source: "game_frame",
        runId: "run_12345678",
        sceneId: "scene_12345678",
        scenePath: "res://demo/main.tscn",
        capturedAtMs: 42,
        viewportWidth: 320,
        viewportHeight: 180,
        frame: 7,
      }],
      usage: {},
      entries: [],
    }],
  });

  const loaded = store.load("session_images001")!;
  assert.deepEqual(loaded.turns[0]?.attachments?.[0], {
    attachmentId,
    mimeType: "image/png",
    detail: "high",
    annotations,
    annotatedFrom,
    byteSize: 123,
    width: 320,
    height: 180,
    source: "game_frame",
    runId: "run_12345678",
    sceneId: "scene_12345678",
    scenePath: "res://demo/main.tscn",
    capturedAtMs: 42,
    viewportWidth: 320,
    viewportHeight: 180,
    frame: 7,
  });
  const storedImage = loaded.messages[0]?.role === "user" && Array.isArray(loaded.messages[0].content)
    ? loaded.messages[0].content.find((part) => part.type === "image")
    : undefined;
  assert.deepEqual(storedImage?.type === "image" ? storedImage.annotations : undefined, annotations);
  const serialized = await readFile(path.join(directory, "session_images001.json"), "utf8");
  assert.doesNotMatch(serialized, /data:image|base64/iu);
  assert.match(serialized, /"annotations":\[/u);
  assert.match(serialized, new RegExp(`"annotatedFrom":"${annotatedFrom}"`, "u"));
});

test("SessionStore removes an incomplete provider transcript during crash recovery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-recovery-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_recovery1",
    title: "Recovery",
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: "user", content: "completed request" },
      { role: "assistant", content: "completed answer", toolCalls: [] },
      { role: "user", content: "unfinished request" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_completed", name: "read_file", arguments: "{}" },
          { id: "call_dangling", name: "read_file", arguments: "{}" },
        ],
      },
      { role: "tool", callId: "call_completed", name: "read_file", content: '{"ok":true}' },
    ],
    turns: [{
      id: "turn_recovery1",
      prompt: "unfinished request",
      model: "test-model",
      status: "running",
      startedAt: now,
      messageStartIndex: 2,
      usage: {},
      entries: [],
    }],
  });

  const recovered = new SessionStore(directory).loadAll()[0];
  assert.equal(recovered?.turns[0]?.status, "interrupted");
  assert.deepEqual(
    recovered?.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "tool", "tool", "assistant"],
  );
  const completedOutput = recovered?.messages.find(
    (message) => message.role === "tool" && message.callId === "call_completed",
  );
  assert.equal(completedOutput?.role === "tool" ? completedOutput.content : "", '{"ok":true}');
  const repairedOutput = recovered?.messages.find(
    (message) => message.role === "tool" && message.callId === "call_dangling",
  );
  assert.match(repairedOutput?.role === "tool" ? repairedOutput.content : "", /GODETX_TURN_INTERRUPTED/u);
});

test("SessionStore rejects stale writes and cannot resurrect a deleted conversation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-conflict-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  const initial = store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_conflict1",
    title: "Initial",
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [],
  });
  const left = store.loadAll()[0]!;
  const stale = store.loadAll()[0]!;
  const updated = store.save({ ...left, title: "Updated" }, left.revision);
  assert.throws(
    () => store.save({ ...stale, title: "Stale overwrite" }, stale.revision),
    SessionConflictError,
  );
  assert.equal(store.delete(initial.id, updated.revision), true);
  assert.throws(() => store.save(stale, stale.revision), SessionConflictError);
  assert.equal(store.loadAll().length, 0);
});

test("SessionStore does not recover a running turn owned by a live connection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-live-owner-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  const session = store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_live0001",
    title: "Live",
    createdAt: now,
    updatedAt: now,
    messages: [{ role: "user", content: "still running" }],
    turns: [{
      id: "turn_live0001",
      prompt: "still running",
      model: "test-model",
      status: "running",
      startedAt: now,
      messageStartIndex: 0,
      usage: {},
      entries: [],
    }],
  });
  store.claimTurn(session.id, "runtime_a");
  assert.equal(store.loadAll()[0]?.turns[0]?.status, "running");
  assert.throws(() => store.claimTurn(session.id, "runtime_b"), SessionConflictError);
  store.releaseTurn(session.id, "runtime_a");
  assert.equal(store.loadAll()[0]?.turns[0]?.status, "interrupted");
});

test("SessionStore keeps persisted tool calls paired and their arguments valid JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-tool-pairs-"));
  const store = new SessionStore(directory);
  const now = new Date().toISOString();
  const calls = Array.from({ length: 65 }, (_, index) => ({
    id: `call_${index}`,
    name: "read_file",
    arguments: index === 0
      ? JSON.stringify({ path: "x".repeat(70_000) })
      : JSON.stringify({ path: `file_${index}.gd` }),
  }));
  const messages: AgentMessage[] = [
    { role: "user", content: "read files" },
    { role: "assistant", content: "", toolCalls: calls },
    ...calls.map((call): AgentMessage => ({
      role: "tool",
      callId: call.id,
      name: call.name,
      content: '{"ok":true}',
    })),
  ];
  store.save({
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: 0,
    id: "session_toolpair1",
    title: "Tool pairs",
    createdAt: now,
    updatedAt: now,
    messages,
    turns: [],
  });

  const loaded = store.loadAll()[0]!;
  const assistant = loaded.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.role === "assistant" ? assistant.toolCalls.length : 0, 64);
  const retainedIds = new Set(assistant?.role === "assistant" ? assistant.toolCalls.map((call) => call.id) : []);
  const outputs = loaded.messages.filter((message) => message.role === "tool");
  assert.equal(outputs.length, 64);
  assert.ok(outputs.every((message) => message.role === "tool" && retainedIds.has(message.callId)));
  if (assistant?.role === "assistant") {
    for (const call of assistant.toolCalls) assert.doesNotThrow(() => JSON.parse(call.arguments));
    assert.equal((JSON.parse(assistant.toolCalls[0]!.arguments) as { persisted_truncated?: boolean }).persisted_truncated, true);
  }
});

test("SessionStore upgrades legacy interrupted transcripts to protocol-valid history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-session-legacy-"));
  const now = new Date().toISOString();
  const filename = "session_legacy001.json";
  await writeFile(path.join(directory, filename), JSON.stringify({
    schemaVersion: 1,
    id: "session_legacy001",
    title: "Legacy",
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: "user", content: "legacy unfinished task" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_legacy", name: "read_file", arguments: "{invalid" }],
      },
    ],
    turns: [{
      id: "turn_legacy001",
      prompt: "legacy unfinished task",
      model: "legacy-model",
      status: "interrupted",
      startedAt: now,
      completedAt: now,
      usage: {},
      entries: [],
    }],
  }), "utf8");

  const loaded = new SessionStore(directory).loadAll()[0]!;
  assert.equal(loaded.schemaVersion, SESSION_STORE_SCHEMA_VERSION);
  assert.equal(loaded.revision, 1);
  const assistant = loaded.messages.find(
    (message) => message.role === "assistant" && message.toolCalls.length > 0,
  );
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    const args = JSON.parse(assistant.toolCalls[0]!.arguments) as { persisted_invalid_arguments?: boolean };
    assert.equal(args.persisted_invalid_arguments, true);
  }
  const repairedOutput = loaded.messages.find(
    (message) => message.role === "tool" && message.callId === "call_legacy",
  );
  assert.match(repairedOutput?.role === "tool" ? repairedOutput.content : "", /GODETX_TURN_INTERRUPTED/u);
  const rewritten = JSON.parse(await readFile(path.join(directory, filename), "utf8")) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, SESSION_STORE_SCHEMA_VERSION);
});

test("session context drops complete old tool cycles when small messages exceed the hard budget", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "continue" }];
  for (let index = 0; index < 300; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `call_${index}`, name: "read_file", arguments: "{}" }],
    });
    messages.push({
      role: "tool",
      callId: `call_${index}`,
      name: "read_file",
      content: JSON.stringify({ ok: true }),
    });
  }
  const prepared = prepareSessionContext(messages, 16_000);
  assert.ok(prepared.stats.contextCharacters <= 16_000);
  for (const [index, message] of prepared.messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      assert.ok(prepared.messages.slice(index + 1).some(
        (candidate) => candidate.role === "tool" && candidate.callId === call.id,
      ));
    }
  }
});

test("session context compaction does not unpair later cycles when a provider reuses a call id", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "continue one turn" }];
  for (let index = 0; index < 3; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call_reused",
        name: "read_file",
        arguments: JSON.stringify({ path: `${index}-${"x".repeat(8_000)}` }),
      }],
    });
    messages.push({
      role: "tool",
      callId: "call_reused",
      name: "read_file",
      content: JSON.stringify({ ok: true, index, content: "y".repeat(10_000) }),
    });
  }
  const prepared = prepareSessionContext(messages, 16_000);
  assert.ok(prepared.stats.contextCharacters <= 16_000);
  assert.ok(prepared.messages.some((message) => message.role === "assistant"));
  for (const [index, message] of prepared.messages.entries()) {
    if (message.role !== "assistant" || message.toolCalls.length === 0) continue;
    const contiguousOutputs: AgentMessage[] = [];
    for (let outputIndex = index + 1; prepared.messages[outputIndex]?.role === "tool"; outputIndex += 1) {
      contiguousOutputs.push(prepared.messages[outputIndex]!);
    }
    for (const call of message.toolCalls) {
      assert.ok(contiguousOutputs.some(
        (candidate) => candidate.role === "tool" && candidate.callId === call.id,
      ));
    }
  }
});

function countImages(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + (
    message.role === "user" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image").length
      : 0
  ), 0);
}
