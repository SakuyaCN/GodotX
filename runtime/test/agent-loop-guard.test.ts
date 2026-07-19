import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLoopGuard,
  canonicalFingerprint,
  type AgentLoopDecision,
  type AgentLoopToolCall,
} from "../src/agent-loop-guard.js";

test("loop guard allows long tasks while each tool step makes novel progress", () => {
  const guard = new AgentLoopGuard();
  for (let index = 0; index < 100; index += 1) {
    assertContinue(guard.beforeModelStep());
    assertContinue(guard.beforeToolBatch([call("read_file", { path: `file-${index}.gd` })]));
    assertContinue(guard.afterToolBatch([{ output: { content: `source-${index}` } }]));
  }
  assert.deepEqual(guard.snapshot(), {
    modelSteps: 100,
    toolCalls: 100,
    consecutiveNoProgressSteps: 0,
    progressEpoch: 100,
    trackedToolBatches: 100,
    trackedSuccessfulOutcomes: 100,
    hasPendingToolBatch: false,
  });
});

test("loop guard stops an identical batch before its third unchanged execution", () => {
  const guard = new AgentLoopGuard();
  const batch = [call("search", { query: "Title" })];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertContinue(guard.beforeToolBatch(batch));
    assertContinue(guard.afterToolBatch([{ output: { matches: [] } }]));
  }

  const decision = guard.beforeToolBatch(batch);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") assert.equal(decision.reason, "repeated_tool_batch");
  assert.equal(guard.snapshot().toolCalls, 2);
});

test("canonical arguments, outputs, and ignored call ids identify the same repeated batch", () => {
  const guard = new AgentLoopGuard();
  const first = [{ id: "one", name: "inspect", arguments: '{"b":2,"a":1}' }];
  const second = [{ id: "two", name: "inspect", arguments: '{ "a": 1, "b": 2 }' }];
  const third = [{ id: "three", name: "inspect", arguments: '{"a":1,"b":2}' }];

  assertContinue(guard.beforeToolBatch(first));
  assertContinue(guard.afterToolBatch([{ output: { z: 2, a: 1 } }]));
  assertContinue(guard.beforeToolBatch(second));
  assertContinue(guard.afterToolBatch([{ output: { a: 1, z: 2 } }]));
  const decision = guard.beforeToolBatch(third);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") assert.equal(decision.reason, "repeated_tool_batch");
});

test("changed output and intervening novel progress invalidate stale repeat evidence", () => {
  const guard = new AgentLoopGuard();
  const inspect = [call("inspect", { path: "demo/main.tscn" })];

  assertContinue(guard.beforeToolBatch(inspect));
  assertContinue(guard.afterToolBatch([{ output: { revision: 1 } }]));
  assertContinue(guard.beforeToolBatch(inspect));
  assertContinue(guard.afterToolBatch([{ output: { revision: 2 } }]));
  assertContinue(guard.beforeToolBatch(inspect));
  assertContinue(guard.afterToolBatch([{ output: { revision: 2 } }]));
  assertContinue(guard.beforeToolBatch([call("apply_patch", { patch: "change" })]));
  assertContinue(guard.afterToolBatch([{ output: { ok: true, changed: true } }]));

  assertContinue(guard.beforeToolBatch(inspect));
});

test("loop guard stops after a configurable run of unsuccessful no-progress steps", () => {
  const guard = new AgentLoopGuard({ consecutiveNoProgressLimit: 3 });
  for (let index = 0; index < 2; index += 1) {
    assertContinue(guard.beforeToolBatch([call("command", { attempt: index })]));
    assertContinue(guard.afterToolBatch([{ output: { ok: false, error: `failure-${index}` } }]));
  }
  assertContinue(guard.beforeToolBatch([call("command", { attempt: 2 })]));
  const decision = guard.afterToolBatch([{ output: { error: "failure-2" } }]);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") assert.equal(decision.reason, "consecutive_no_progress");
  assert.equal(guard.snapshot().consecutiveNoProgressSteps, 3);
});

test("default adaptive policy stops eight distinct unsuccessful steps", () => {
  const guard = new AgentLoopGuard();
  for (let index = 0; index < 7; index += 1) {
    assertContinue(guard.beforeToolBatch([call("command", { attempt: index })]));
    assertContinue(guard.afterToolBatch([{ output: { ok: false, error: `failure-${index}` } }]));
  }
  assertContinue(guard.beforeToolBatch([call("command", { attempt: 7 })]));
  const decision = guard.afterToolBatch([{ output: { ok: false, error: "failure-7" } }]);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") assert.equal(decision.reason, "consecutive_no_progress");
});

test("explicit successful outcomes can override the default result classifier", () => {
  const guard = new AgentLoopGuard({ consecutiveNoProgressLimit: 1 });
  assertContinue(guard.beforeToolBatch([call("expected_error", {})]));
  assertContinue(
    guard.afterToolBatch([{ output: { ok: false, error: "expected" }, successful: true }]),
  );
  assert.equal(guard.snapshot().progressEpoch, 1);
});

test("emergency model and tool limits stop before exceeding their budgets", () => {
  const modelGuard = new AgentLoopGuard({ emergencyModelStepLimit: 2 });
  assertContinue(modelGuard.beforeModelStep());
  assertContinue(modelGuard.beforeModelStep());
  const modelDecision = modelGuard.beforeModelStep();
  assert.equal(modelDecision.action, "stop");
  if (modelDecision.action === "stop") {
    assert.equal(modelDecision.reason, "emergency_model_step_limit");
  }

  const toolGuard = new AgentLoopGuard({ emergencyToolCallLimit: 3 });
  assertContinue(toolGuard.beforeToolBatch([call("one", {}), call("two", {})]));
  assertContinue(
    toolGuard.afterToolBatch([{ output: { value: 1 } }, { output: { value: 2 } }]),
  );
  const toolDecision = toolGuard.beforeToolBatch([call("three", {}), call("four", {})]);
  assert.equal(toolDecision.action, "stop");
  if (toolDecision.action === "stop") assert.equal(toolDecision.reason, "emergency_tool_call_limit");
  assert.equal(toolGuard.snapshot().toolCalls, 2);
});

test("fingerprint retention remains bounded", () => {
  const guard = new AgentLoopGuard({ trackedFingerprintLimit: 3 });
  for (let index = 0; index < 20; index += 1) {
    assertContinue(guard.beforeToolBatch([call("read", { index })]));
    assertContinue(guard.afterToolBatch([{ output: { index } }]));
  }
  const snapshot = guard.snapshot();
  assert.equal(snapshot.trackedToolBatches, 3);
  assert.equal(snapshot.trackedSuccessfulOutcomes, 3);
});

test("canonical fingerprints are stable for object key order and handle cycles", () => {
  assert.equal(canonicalFingerprint({ b: 2, a: [1, true] }), canonicalFingerprint({ a: [1, true], b: 2 }));
  const circular: Record<string, unknown> = { name: "root" };
  circular.self = circular;
  assert.doesNotThrow(() => canonicalFingerprint(circular));
  assert.equal(canonicalFingerprint(circular), canonicalFingerprint(circular));
});

test("loop guard enforces checkpoint ordering", () => {
  const guard = new AgentLoopGuard();
  assert.throws(() => guard.afterToolBatch([]), /No tool batch is pending/u);
  assert.throws(() => guard.beforeToolBatch([]), /at least one call/u);
  assertContinue(guard.beforeToolBatch([call("read", {})]));
  assert.throws(() => guard.beforeModelStep(), /tool batch is pending/u);
  assert.throws(() => guard.afterToolBatch([]), /Expected 1 tool outcomes/u);
});

function call(name: string, argumentsValue: unknown): AgentLoopToolCall {
  return { name, arguments: JSON.stringify(argumentsValue) };
}

function assertContinue(decision: AgentLoopDecision): void {
  assert.equal(decision.action, "continue");
}
