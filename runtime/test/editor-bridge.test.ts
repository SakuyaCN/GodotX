import assert from "node:assert/strict";
import test from "node:test";
import {
  EditorToolBridge,
  EditorToolBridgeError,
  type EditorToolExecutionContext,
} from "../src/editor-bridge.js";
import type { EditorToolRequestData } from "../src/protocol.js";

test("editor bridge emits requests, resolves results, and rejects unknown or duplicate responses", async () => {
  const emitted: Array<{ request: EditorToolRequestData; context: EditorToolExecutionContext }> = [];
  const bridge = new EditorToolBridge((request, context) => emitted.push({ request, context }), {
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const context: EditorToolExecutionContext = {
    signal: controller.signal,
    sessionId: "session-1",
    turnId: "turn-1",
    itemId: "item-1",
    sceneLease: {
      scene_id: "scene-1",
      scene_path: "res://main.tscn",
      scene_revision: "revision-1",
    },
  };

  const resultPromise = bridge.execute("scene.get_tree", { depth: 3 }, context);
  assert.equal(emitted.length, 1);
  const requestId = emitted[0]?.request.request_id ?? "";
  assert.match(requestId, /^editor_/);
  assert.deepEqual(emitted[0]?.request, {
    request_id: requestId,
    tool: "scene.get_tree",
    arguments: { depth: 3 },
    scene_lease: {
      scene_id: "scene-1",
      scene_path: "res://main.tscn",
      scene_revision: "revision-1",
    },
  });
  assert.notEqual(emitted[0]?.request.scene_lease, context.sceneLease);
  assert.equal(emitted[0]?.context, context);

  assert.equal(bridge.respond({ request_id: requestId, result: { ok: true, nodes: 4 } }), requestId);
  assert.deepEqual(await resultPromise, { ok: true, nodes: 4 });
  assert.throws(
    () => bridge.respond({ request_id: requestId, result: { ok: true } }),
    bridgeError("EDITOR_REQUEST_ALREADY_RESOLVED"),
  );
  assert.throws(
    () => bridge.respond({ request_id: "editor_missing", result: { ok: true } }),
    bridgeError("EDITOR_REQUEST_NOT_FOUND"),
  );
  bridge.close();
});

test("editor bridge propagates structured editor errors and rejects malformed known responses", async () => {
  const requests: EditorToolRequestData[] = [];
  const bridge = new EditorToolBridge((request) => requests.push(request), { timeoutMs: 1_000 });
  const controller = new AbortController();

  const failed = bridge.execute("node.inspect", { path: "Root/Missing" }, { signal: controller.signal });
  const failedAssertion = assert.rejects(
    failed,
    (error: unknown) => {
      assert.ok(error instanceof EditorToolBridgeError);
      assert.equal(error.code, "NODE_NOT_FOUND");
      assert.equal(error.message, "Node does not exist");
      assert.deepEqual(error.data, { path: "Root/Missing" });
      return true;
    },
  );
  const failedId = requests[0]?.request_id ?? "";
  assert.equal(
    bridge.respond({
      request_id: failedId,
      error: { code: "NODE_NOT_FOUND", message: "Node does not exist", data: { path: "Root/Missing" } },
    }),
    failedId,
  );
  await failedAssertion;

  const malformed = bridge.execute("node.inspect", {}, { signal: controller.signal });
  const malformedAssertion = assert.rejects(malformed, bridgeError("EDITOR_RESPONSE_INVALID"));
  const malformedId = requests[1]?.request_id ?? "";
  assert.throws(
    () => bridge.respond({ request_id: malformedId, result: "not-an-object" }),
    bridgeError("EDITOR_RESPONSE_INVALID"),
  );
  await malformedAssertion;
  bridge.close();
});

test("editor bridge times out pending calls and rejects late responses", async () => {
  let requestId = "";
  const bridge = new EditorToolBridge((request) => {
    requestId = request.request_id;
  }, { timeoutMs: 10 });

  await assert.rejects(
    bridge.execute("editor.wait", {}, { signal: new AbortController().signal }),
    bridgeError("EDITOR_TOOL_TIMEOUT"),
  );
  assert.throws(
    () => bridge.respond({ request_id: requestId, result: { ok: true } }),
    bridgeError("EDITOR_REQUEST_ALREADY_RESOLVED"),
  );
  bridge.close();
});

test("editor bridge handles abort, reconfiguration reset, and disconnect cleanup", async () => {
  const requests: EditorToolRequestData[] = [];
  const bridge = new EditorToolBridge((request) => requests.push(request), { timeoutMs: 1_000 });

  const abortedController = new AbortController();
  const aborted = bridge.execute("node.inspect", {}, { signal: abortedController.signal });
  const abortedAssertion = assert.rejects(aborted, bridgeError("EDITOR_TOOL_ABORTED"));
  abortedController.abort();
  await abortedAssertion;

  const reset = bridge.execute("scene.get_tree", {}, { signal: new AbortController().signal });
  const resetAssertion = assert.rejects(reset, bridgeError("EDITOR_BRIDGE_RECONFIGURED"));
  bridge.reset();
  await resetAssertion;

  const afterReset = bridge.execute("scene.get_tree", {}, { signal: new AbortController().signal });
  const afterResetId = requests.at(-1)?.request_id ?? "";
  bridge.respond({ request_id: afterResetId, result: { ok: true } });
  assert.deepEqual(await afterReset, { ok: true });

  const disconnected = bridge.execute("scene.get_tree", {}, { signal: new AbortController().signal });
  const disconnectedAssertion = assert.rejects(disconnected, bridgeError("EDITOR_BRIDGE_DISCONNECTED"));
  bridge.close();
  await disconnectedAssertion;
  await assert.rejects(
    bridge.execute("scene.get_tree", {}, { signal: new AbortController().signal }),
    bridgeError("EDITOR_BRIDGE_DISCONNECTED"),
  );
});

function bridgeError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof EditorToolBridgeError);
    assert.equal(error.code, code);
    return true;
  };
}
