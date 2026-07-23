import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import type { EditorToolClient, EditorToolExecutionContext } from "../src/editor-bridge.js";
import { EventFactory, type RuntimeEvent } from "../src/protocol.js";
import { ToolRegistry, type ToolContext } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

const EDITOR_TOOL_NAMES = [
  "scene_get_tree",
  "editor_get_selection",
  "node_get_properties",
  "resource_inspect",
  "scene_apply_operations",
  "game_debug_start",
  "game_debug_status",
  "game_capture_screenshot",
  "game_debug_stop",
  "game_automation_run",
  "game_automation_status",
  "game_automation_cancel",
  "game_test",
];

const AUTOMATION_RUN_ID = "0123456789abcdef0123456789abcdef";
const AUTOMATION_ID = "automation_0123456789abcdef";

class FakeEditorToolClient implements EditorToolClient {
  calls: Array<{
    tool: string;
    args: Record<string, unknown>;
    context: EditorToolExecutionContext;
  }> = [];
  nextResult: Record<string, unknown> | undefined;
  onExecute: ((
    tool: string,
    args: Record<string, unknown>,
    context: EditorToolExecutionContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>) | undefined;

  async execute(
    tool: string,
    args: Record<string, unknown>,
    context: EditorToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ tool, args, context });
    if (this.onExecute) return this.onExecute(tool, args, context);
    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = undefined;
      return result;
    }
    if (tool === "scene_apply_operations") {
      return {
        ok: true,
        scene_id: args.scene_id,
        scene_path: context.sceneLease?.scene_path ?? "",
        previous_scene_revision: args.scene_revision,
        scene_revision: `${String(args.scene_revision)}-next`,
      };
    }
    if (tool !== "resource_inspect" && context.sceneLease) {
      return {
        ok: true,
        scene_id: context.sceneLease.scene_id,
        scene_path: context.sceneLease.scene_path,
        scene_revision: context.sceneLease.scene_revision,
        tool,
        args,
      };
    }
    return { ok: true, tool, args };
  }
}

test("tool kernel advertises editor tools only when an editor bridge is available", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-kernel-")));
  const core = new ToolRegistry(workspace);
  assert.deepEqual(
    core.definitions().filter((definition) => EDITOR_TOOL_NAMES.includes(definition.name)),
    [],
  );

  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  assert.deepEqual(
    kernel.definitions().filter((definition) => EDITOR_TOOL_NAMES.includes(definition.name)).map((tool) => tool.name),
    EDITOR_TOOL_NAMES,
  );
  for (const name of EDITOR_TOOL_NAMES) {
    const schema = kernel.definitions().find((definition) => definition.name === name);
    assert.equal((schema?.parameters as { additionalProperties?: boolean }).additionalProperties, false);
  }
  const writeSchema = kernel.definitions().find((definition) => definition.name === "scene_apply_operations");
  const treeSchema = kernel.definitions().find((definition) => definition.name === "scene_get_tree");
  const treeParameters = treeSchema?.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(treeParameters.properties?.scene_id);
  assert.equal(treeParameters.required?.includes("scene_id") ?? false, false);
  const writeProperties = (writeSchema?.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  }).properties;
  assert.deepEqual(
    (writeSchema?.parameters as { required?: string[] }).required,
    ["scene_id", "operations"],
  );
  assert.equal(Object.hasOwn(writeProperties ?? {}, "operation_id"), false);
  assert.equal(Object.hasOwn(writeProperties ?? {}, "scene_revision"), false);
  assert.match(writeSchema?.description ?? "", /Runtime securely binds/);
  assert.match(writeSchema?.description ?? "", /one Godot undo action/);
  assert.match(writeSchema?.description ?? "", /leaves? the scene unsaved/);
  const serializedWriteSchema = JSON.stringify(writeSchema?.parameters ?? {});
  assert.match(serializedWriteSchema, /int64/);
  assert.match(serializedWriteSchema, /Vector4/);
  assert.match(serializedWriteSchema, /Vector4i/);

  const startSchema = kernel.definitions().find((definition) => definition.name === "game_debug_start");
  const startParameters = startSchema?.parameters as {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
  assert.deepEqual(startParameters.properties?.mode?.enum, ["main", "current", "scene"]);
  assert.deepEqual(startParameters.required, ["mode"]);
  assert.match(startSchema?.description ?? "", /requires user approval/i);
  assert.match(startSchema?.description ?? "", /scene_path for main and current.*ignored/i);

  const statusSchema = kernel.definitions().find((definition) => definition.name === "game_debug_status");
  const historyLimit = (statusSchema?.parameters as {
    properties?: Record<string, { minimum?: number; maximum?: number; default?: number }>;
  }).properties?.history_limit;
  assert.deepEqual(historyLimit, {
    type: "integer",
    minimum: 1,
    maximum: 500,
    default: 100,
    description: "Maximum number of recent output records to return",
  });
  const screenshotSchema = kernel.definitions().find((definition) => definition.name === "game_capture_screenshot");
  assert.deepEqual(
    (screenshotSchema?.parameters as { required?: string[] }).required,
    ["run_id"],
  );
  assert.match(screenshotSchema?.description ?? "", /visual observation/i);
  const stopSchema = kernel.definitions().find((definition) => definition.name === "game_debug_stop");
  assert.deepEqual(
    (stopSchema?.parameters as { required?: string[] }).required,
    ["run_id"],
  );
  const automationRunSchema = kernel.definitions().find((definition) => definition.name === "game_automation_run");
  assert.deepEqual(
    (automationRunSchema?.parameters as { required?: string[] }).required,
    ["run_id", "steps"],
  );
  assert.match(automationRunSchema?.description ?? "", /whole plan locally/i);
  assert.match(JSON.stringify(automationRunSchema?.parameters), /7200 frames/);
  for (const name of ["game_automation_status", "game_automation_cancel"]) {
    const schema = kernel.definitions().find((definition) => definition.name === name);
    assert.deepEqual(
      (schema?.parameters as { required?: string[] }).required,
      ["run_id", "automation_id"],
    );
  }
  const gameTestSchema = kernel.definitions().find((definition) => definition.name === "game_test");
  const gameTestParameters = gameTestSchema?.parameters as {
    properties?: Record<string, { default?: unknown; enum?: string[] }>;
    required?: string[];
  };
  assert.deepEqual(gameTestParameters.required, ["target", "steps"]);
  assert.equal(gameTestParameters.properties?.cleanup?.default, "always");
  assert.deepEqual(
    gameTestParameters.properties?.cleanup?.enum,
    ["always", "on_success", "never"],
  );
  assert.equal(gameTestParameters.properties?.capture?.default, "never");
  assert.deepEqual(
    gameTestParameters.properties?.capture?.enum,
    ["never", "after", "on_failure", "always"],
  );
  assert.match(gameTestSchema?.description ?? "", /complete provider-neutral game verification/i);
});

test("game screenshot returns metadata to tools and a provider-neutral image observation", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-visual-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  const attachmentId = "a".repeat(64);
  editorClient.nextResult = {
    ok: true,
    attachment_id: attachmentId,
    mime_type: "image/png",
    width: 1280,
    height: 720,
    size_bytes: 42_000,
    detail: "high",
    source: "game_frame",
    run_id: AUTOMATION_RUN_ID,
    capture_id: "capture_0123456789abcdef",
    scene_path: "res://demo/main.tscn",
    frame: 42,
    viewport_width: 1280,
    viewport_height: 720,
    captured_at_ms: 1234,
  };

  const execution = await kernel.executeWithObservations({
    id: "capture-game-frame",
    name: "game_capture_screenshot",
    arguments: JSON.stringify({
      run_id: AUTOMATION_RUN_ID,
      max_dimension: 1280,
      detail: "low",
    }),
  }, context);

  assert.equal(execution.output.attachment_id, attachmentId);
  assert.deepEqual(editorClient.calls[0]?.args, {
    run_id: AUTOMATION_RUN_ID,
    max_dimension: 1280,
  });
  assert.match(String(execution.observations?.[0]?.type === "text" ? execution.observations[0].text : ""), /frame 42/);
  assert.deepEqual(execution.observations?.[1], {
    type: "image",
    attachmentId,
    mimeType: "image/png",
    detail: "low",
  });
});

test("runtime automation routes one normalized bounded plan without approval or a scene lease", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-automation-route-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;

  await kernel.execute({
    id: "automation-run",
    name: "game_automation_run",
    arguments: JSON.stringify({
      run_id: AUTOMATION_RUN_ID,
      steps: [
        { type: "wait_frames", frames: 2 },
        { type: "click_control", node_path: "HUD/Start" },
        { type: "press_action", action: "ui_accept", duration_frames: 3 },
        { type: "press_action", action: "ui_cancel", pressed: false },
        { type: "assert_node", node_path: "HUD/Result", check: "exists" },
        {
          type: "assert_node",
          node_path: "HUD/Result",
          check: "property_contains",
          property: "text",
          value: "won",
          timeout_frames: 60,
        },
      ],
    }),
  }, context);
  await kernel.execute({
    id: "automation-status",
    name: "game_automation_status",
    arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID }),
  }, context);
  await kernel.execute({
    id: "automation-cancel",
    name: "game_automation_cancel",
    arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID }),
  }, context);

  assert.deepEqual(editorClient.calls.map((call) => call.tool), [
    "game_automation_run",
    "game_automation_status",
    "game_automation_cancel",
  ]);
  assert.deepEqual(editorClient.calls[0]?.args, {
    run_id: AUTOMATION_RUN_ID,
    steps: [
      { type: "wait_frames", frames: 2 },
      { type: "click_control", node_path: "HUD/Start", button: 1 },
      { type: "press_action", action: "ui_accept", pressed: true, duration_frames: 3 },
      { type: "press_action", action: "ui_cancel", pressed: false },
      { type: "assert_node", node_path: "HUD/Result", check: "exists", exists: true, timeout_frames: 0 },
      {
        type: "assert_node",
        node_path: "HUD/Result",
        check: "property_contains",
        property: "text",
        value: "won",
        timeout_frames: 60,
      },
    ],
    stop_on_failure: true,
  });
  assert.deepEqual(editorClient.calls[1]?.args, { run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID });
  assert.deepEqual(editorClient.calls[2]?.args, { run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID });
  for (const call of editorClient.calls) assert.equal(call.context.sceneLease, undefined);
  assert.equal(events.some((event) => event.type.startsWith("approval.")), false);
});

test("runtime automation switch blocks run and cancel while leaving status read-only", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-automation-switch-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();

  await assert.rejects(
    kernel.execute({
      id: "disabled-run",
      name: "game_automation_run",
      arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, steps: [{ type: "wait_frames", frames: 1 }] }),
    }, context),
    /automation is disabled/i,
  );
  await kernel.execute({
    id: "disabled-status",
    name: "game_automation_status",
    arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID }),
  }, context);
  await assert.rejects(
    kernel.execute({
      id: "disabled-cancel",
      name: "game_automation_cancel",
      arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID }),
    }, context),
    /automation is disabled/i,
  );

  assert.deepEqual(editorClient.calls.map((call) => call.tool), ["game_automation_status"]);
});

test("runtime automation rejects malformed or unbounded plans before editor routing", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-automation-invalid-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  context.runtimeAutomationEnabled = true;
  const invalid = [
    { args: { run_id: "short", steps: [{ type: "wait_frames", frames: 1 }] }, error: /run_id must be/ },
    { args: { run_id: AUTOMATION_RUN_ID, steps: [] }, error: /between 1 and 64/ },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: Array.from({ length: 65 }, () => ({ type: "wait_frames", frames: 1 })) },
      error: /between 1 and 64/,
    },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "wait_frames", frames: 3600 }, { type: "wait_frames", frames: 3600 }, { type: "wait_frames", frames: 1 }] },
      error: /must not exceed 7200/,
    },
    { args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "unknown" }] }, error: /type must be one of/ },
    { args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "click_control", node_path: "../Exit" }] }, error: /safe Godot node name/ },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "press_action", action: "ui_accept", pressed: false, duration_frames: 1 }] },
      error: /not allowed when pressed is false/,
    },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "assert_node", node_path: ".", check: "property_equals", property: "text" }] },
      error: /value is required/,
    },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "assert_node", node_path: ".", check: "exists", property: "text" }] },
      error: /unsupported field: property/,
    },
    {
      args: { run_id: AUTOMATION_RUN_ID, steps: [{ type: "wait_frames", frames: 1, extra: true }] },
      error: /unsupported field: extra/,
    },
  ];
  for (const [index, entry] of invalid.entries()) {
    await assert.rejects(
      kernel.execute({
        id: `invalid-automation-${index}`,
        name: "game_automation_run",
        arguments: JSON.stringify(entry.args),
      }, context),
      entry.error,
    );
  }
  for (const name of ["game_automation_status", "game_automation_cancel"]) {
    await assert.rejects(
      kernel.execute({
        id: `invalid-${name}`,
        name,
        arguments: JSON.stringify({ run_id: AUTOMATION_RUN_ID, automation_id: "short" }),
      }, context),
      /automation_id must be/,
    );
  }
  assert.equal(editorClient.calls.length, 0);
});

test("game_test runs one approved local workflow, drains bounded logs, and stops the exact run", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-success-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  let automationReads = 0;
  let debugReads = 0;
  let stopRequested = false;
  editorClient.onExecute = (tool, args) => {
    switch (tool) {
      case "game_debug_start":
        return { ok: true, run_id: AUTOMATION_RUN_ID, launch_requested: true, ...args };
      case "game_debug_status":
        debugReads += 1;
        return {
          ok: true,
          run_id: AUTOMATION_RUN_ID,
          owned: !stopRequested,
          playing: !stopRequested,
          launch_observed: true,
          probe_confirmed: true,
          next_seq: debugReads,
          has_more: false,
          entries: stopRequested
            ? []
            : [{ seq: debugReads, kind: "print", level: "info", text: debugReads === 1 ? "Ready" : "Won" }],
        };
      case "game_automation_run":
        return {
          ok: true,
          run_id: AUTOMATION_RUN_ID,
          automation_id: AUTOMATION_ID,
          state: "queued",
        };
      case "game_automation_status":
        automationReads += 1;
        return automationReads === 1
          ? {
              ok: true,
              run_id: AUTOMATION_RUN_ID,
              automation_id: AUTOMATION_ID,
              state: "running",
              current_step: 1,
              step_count: 2,
              results: [{ index: 0, type: "wait_frames", state: "passed", message: "Waited" }],
            }
          : {
              ok: true,
              run_id: AUTOMATION_RUN_ID,
              automation_id: AUTOMATION_ID,
              state: "passed",
              current_step: 2,
              step_count: 2,
              results: [
                { index: 0, type: "wait_frames", state: "passed", message: "Waited" },
                { index: 1, type: "assert_node", state: "passed", message: "Matched" },
              ],
            };
      case "game_capture_screenshot":
        return {
          ok: true,
          attachment_id: "b".repeat(64),
          mime_type: "image/png",
          width: 1280,
          height: 720,
          size_bytes: 42_000,
          source: "game_frame",
          run_id: AUTOMATION_RUN_ID,
          capture_id: "capture_0123456789abcdef",
          scene_path: "res://demo/live.tscn",
          frame: 77,
          viewport_width: 1280,
          viewport_height: 720,
          captured_at_ms: 1234,
        };
      case "game_debug_stop":
        stopRequested = true;
        return { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true };
      default:
        throw new Error(`Unexpected editor tool: ${tool}`);
    }
  };

  const execution = kernel.executeWithObservations({
    id: "game-test-success",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "current" },
      steps: [
        { type: "wait_frames", frames: 1 },
        { type: "assert_node", node_path: "Status", check: "property_equals", property: "text", value: "Won" },
      ],
      capture: "after",
      capture_max_dimension: 1280,
      capture_detail: "low",
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  const approvalData = approval.data as { request_id: string; arguments: Record<string, unknown> };
  assert.deepEqual(approvalData.arguments, { mode: "scene", scene_path: "res://demo/live.tscn" });
  assert.equal(context.approvals.respond(approvalData.request_id, "accept"), true);

  const executionResult = await execution;
  const result = executionResult.output;
  assert.equal(result.ok, true);
  assert.equal(result.state, "passed");
  assert.equal(result.run_id, AUTOMATION_RUN_ID);
  assert.equal(result.automation_id, AUTOMATION_ID);
  assert.equal(result.stopped, true);
  assert.equal(result.failure, null);
  assert.deepEqual(executionResult.observations?.[1], {
    type: "image",
    attachmentId: "b".repeat(64),
    mimeType: "image/png",
    detail: "low",
  });
  assert.deepEqual(result.visual, {
    policy: "after",
    attempted: true,
    capture: {
      ok: true,
      attachment_id: "b".repeat(64),
      mime_type: "image/png",
      width: 1280,
      height: 720,
      size_bytes: 42_000,
      source: "game_frame",
      run_id: AUTOMATION_RUN_ID,
      capture_id: "capture_0123456789abcdef",
      scene_path: "res://demo/live.tscn",
      frame: 77,
      viewport_width: 1280,
      viewport_height: 720,
      captured_at_ms: 1234,
    },
    warning: null,
  });
  assert.deepEqual(result.cleanup, {
    policy: "always",
    attempted: true,
    cancel_attempted: false,
    cancel: null,
    stop_attempted: true,
    stop_requested: true,
    stop: { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true },
    already_stopped: true,
    stopped: true,
    warning: null,
  });
  const launch = result.launch as { status: { entries?: Array<{ text?: string }> } };
  assert.deepEqual(launch.status.entries?.map((entry) => entry.text), ["Ready", "Won"]);
  assert.deepEqual(editorClient.calls.map((call) => call.tool), [
    "game_debug_start",
    "game_debug_status",
    "game_automation_run",
    "game_automation_status",
    "game_automation_status",
    "game_debug_status",
    "game_capture_screenshot",
    "game_debug_stop",
    "game_debug_status",
  ]);
  assert.deepEqual(editorClient.calls[0]?.args, approvalData.arguments);
  assert.deepEqual(editorClient.calls[2]?.args, {
    run_id: AUTOMATION_RUN_ID,
    steps: [
      { type: "wait_frames", frames: 1 },
      {
        type: "assert_node",
        node_path: "Status",
        check: "property_equals",
        property: "text",
        value: "Won",
        timeout_frames: 0,
      },
    ],
    stop_on_failure: true,
  });
  const phases = events
    .filter((event) => event.type === "tool.output.delta")
    .map((event) => (event.data as { phase?: string }).phase);
  assert.deepEqual([...new Set(phases)], [
    "validating",
    "starting",
    "waiting_for_probe",
    "running_automation",
    "capturing_frame",
    "cleaning_up",
    "completed",
  ]);
  const progress = events.find((event) => (
    event.type === "tool.output.delta" &&
    (event.data as { automation_id?: string }).automation_id === AUTOMATION_ID
  ));
  assert.equal((progress?.data as { kind?: string }).kind, "game_test.progress");
  assert.match((progress?.data as { delta?: string }).delta ?? "", /automation/i);
  const timings = result.timings_ms as Record<string, unknown>;
  for (const key of ["total", "ready", "automation", "cleanup"]) {
    assert.equal(typeof timings[key], "number");
  }
});

test("game_test honors on_success after a terminal failure", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-failure-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  editorClient.onExecute = (tool) => {
    if (tool === "game_debug_start") return { ok: true, run_id: AUTOMATION_RUN_ID };
    if (tool === "game_debug_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        owned: true,
        playing: true,
        launch_observed: true,
        probe_confirmed: true,
        next_seq: 0,
        has_more: false,
        entries: [],
      };
    }
    if (tool === "game_automation_run") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID, state: "queued" };
    }
    if (tool === "game_automation_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: AUTOMATION_ID,
        state: "failed",
        current_step: 1,
        step_count: 1,
        failure: "Assertion failed",
        results: [{ index: 0, type: "assert_node", state: "failed", message: "Mismatch" }],
      };
    }
    throw new Error(`Unexpected editor tool: ${tool}`);
  };

  const execution = kernel.execute({
    id: "game-test-failure",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "scene", scene_path: "demo/main.tscn" },
      steps: [{ type: "assert_node", node_path: ".", check: "exists" }],
      cleanup: "on_success",
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.equal(
    context.approvals.respond((approval.data as { request_id: string }).request_id, "accept"),
    true,
  );
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.state, "failed");
  assert.equal(result.failure, "Assertion failed");
  assert.equal(result.stopped, false);
  assert.equal((result.cleanup as { attempted: boolean }).attempted, false);
  assert.equal(editorClient.calls.some((call) => call.tool === "game_debug_stop"), false);
});

test("game_test reports cleanup_failed when an accepted stop is not confirmed", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-stop-confirm-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  editorClient.onExecute = (tool) => {
    if (tool === "game_debug_start") return { ok: true, run_id: AUTOMATION_RUN_ID };
    if (tool === "game_debug_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        owned: true,
        playing: true,
        launch_observed: true,
        probe_confirmed: true,
        next_seq: 0,
        has_more: false,
        entries: [],
      };
    }
    if (tool === "game_automation_run") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID, state: "queued" };
    }
    if (tool === "game_automation_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: AUTOMATION_ID,
        state: "passed",
        current_step: 1,
        step_count: 1,
        results: [{ index: 0, type: "wait_frames", state: "passed", message: "Done" }],
      };
    }
    if (tool === "game_debug_stop") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true };
    }
    throw new Error(`Unexpected editor tool: ${tool}`);
  };

  const execution = kernel.execute({
    id: "game-test-stop-confirm",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "main" },
      steps: [{ type: "wait_frames", frames: 1 }],
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  context.approvals.respond((approval.data as { request_id: string }).request_id, "accept");
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.state, "cleanup_failed");
  assert.equal(result.stopped, false);
  assert.match(String(result.failure), /not confirmed/i);
  const cleanup = result.cleanup as Record<string, unknown>;
  assert.equal(cleanup.stop_requested, true);
  assert.equal(cleanup.stopped, false);
  assert.match(String(cleanup.warning), /not confirmed/i);
});

test("game_test rejects mismatched automation status and cleans only the original identifiers", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-identity-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  let stopRequested = false;
  editorClient.onExecute = (tool) => {
    if (tool === "game_debug_start") return { ok: true, run_id: AUTOMATION_RUN_ID };
    if (tool === "game_debug_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        owned: !stopRequested,
        playing: !stopRequested,
        launch_observed: true,
        probe_confirmed: true,
        next_seq: 0,
        has_more: false,
        entries: [],
      };
    }
    if (tool === "game_automation_run") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID, state: "queued" };
    }
    if (tool === "game_automation_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: "automation_ffffffffffffffff",
        state: "passed",
        current_step: 1,
        step_count: 1,
        results: [],
      };
    }
    if (tool === "game_automation_cancel") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID, state: "cancelled" };
    }
    if (tool === "game_debug_stop") {
      stopRequested = true;
      return { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true };
    }
    throw new Error(`Unexpected editor tool: ${tool}`);
  };

  const execution = kernel.execute({
    id: "game-test-identity",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "main" },
      steps: [{ type: "wait_frames", frames: 1 }],
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  context.approvals.respond((approval.data as { request_id: string }).request_id, "accept");
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.state, "automation_failed");
  assert.equal(result.run_id, AUTOMATION_RUN_ID);
  assert.equal(result.automation_id, AUTOMATION_ID);
  const cancel = editorClient.calls.find((call) => call.tool === "game_automation_cancel");
  const stop = editorClient.calls.find((call) => call.tool === "game_debug_stop");
  assert.deepEqual(cancel?.args, { run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID });
  assert.deepEqual(stop?.args, { run_id: AUTOMATION_RUN_ID });
});

test("game_test cancellation still stops its exact run when independent automation cancel fails", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-abort-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  const controller = new AbortController();
  context.signal = controller.signal;
  const cleanupSignals: AbortSignal[] = [];
  let abortStopRequested = false;
  editorClient.onExecute = (tool, args, executionContext) => {
    if (tool === "game_debug_start") return { ok: true, run_id: AUTOMATION_RUN_ID };
    if (tool === "game_debug_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        owned: !abortStopRequested,
        playing: !abortStopRequested,
        launch_observed: true,
        probe_confirmed: true,
        next_seq: 0,
        has_more: false,
        entries: [],
      };
    }
    if (tool === "game_automation_run") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, automation_id: AUTOMATION_ID, state: "queued" };
    }
    if (tool === "game_automation_status") {
      controller.abort();
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: AUTOMATION_ID,
        state: "running",
        current_step: 0,
        step_count: 1,
        results: [],
      };
    }
    if (tool === "game_automation_cancel" || tool === "game_debug_stop") {
      cleanupSignals.push(executionContext.signal);
      assert.equal(executionContext.signal.aborted, false);
      assert.notEqual(executionContext.signal, context.signal);
      if (tool === "game_automation_cancel") throw new Error("Cancel transport failed");
      if (tool === "game_debug_stop") abortStopRequested = true;
      return { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true };
    }
    throw new Error(`Unexpected editor tool: ${tool}`);
  };

  const execution = kernel.execute({
    id: "game-test-abort",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "main" },
      steps: [{ type: "wait_frames", frames: 60 }],
      cleanup: "never",
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.equal(
    context.approvals.respond((approval.data as { request_id: string }).request_id, "accept"),
    true,
  );
  await assert.rejects(execution, /abort|cancel/i);
  assert.deepEqual(editorClient.calls.slice(-3).map((call) => call.tool), [
    "game_automation_cancel",
    "game_debug_stop",
    "game_debug_status",
  ]);
  assert.equal(cleanupSignals.length, 2);
  assert.notEqual(cleanupSignals[0], cleanupSignals[1]);
  const completed = events.find((event) => (
    event.type === "tool.output.delta" &&
    (event.data as { phase?: string }).phase === "completed"
  ));
  assert.equal((completed?.data as { state?: string }).state, "cancelled");
});

test("game_test bounds adversarial editor logs and automation results to 64 KiB", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-bounded-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.runtimeAutomationEnabled = true;
  const huge = "x".repeat(20_000);
  let stopRequested = false;
  editorClient.onExecute = (tool) => {
    if (tool === "game_debug_start") {
      return { ok: true, run_id: AUTOMATION_RUN_ID, error: huge, metadata: huge };
    }
    if (tool === "game_debug_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        owned: !stopRequested,
        playing: !stopRequested,
        launch_observed: true,
        probe_confirmed: true,
        mode: huge,
        requested_scene_path: huge,
        playing_scene_path: huge,
        scene_path: huge,
        runtime_probe_error: huge,
        error: huge,
        next_seq: 64,
        has_more: false,
        entries: stopRequested
          ? []
          : Array.from({ length: 64 }, (_, index) => ({
              seq: index + 1,
              kind: huge,
              level: huge,
              source: huge,
              function: huge,
              text: huge,
            })),
      };
    }
    if (tool === "game_automation_run") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: AUTOMATION_ID,
        state: "queued",
        error: huge,
      };
    }
    if (tool === "game_automation_status") {
      return {
        ok: true,
        run_id: AUTOMATION_RUN_ID,
        automation_id: AUTOMATION_ID,
        state: "passed",
        current_step: 64,
        step_count: 64,
        failure: huge,
        error: huge,
        results: Array.from({ length: 64 }, (_, index) => ({
          index,
          type: huge,
          state: huge,
          message: huge,
        })),
      };
    }
    if (tool === "game_debug_stop") {
      stopRequested = true;
      return { ok: true, run_id: AUTOMATION_RUN_ID, stop_requested: true, error: huge };
    }
    throw new Error(`Unexpected editor tool: ${tool}`);
  };

  const execution = kernel.execute({
    id: "game-test-bounded",
    name: "game_test",
    arguments: JSON.stringify({
      target: { mode: "main" },
      steps: [{ type: "wait_frames", frames: 1 }],
    }),
  }, context);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.equal(
    context.approvals.respond((approval.data as { request_id: string }).request_id, "accept"),
    true,
  );
  const result = await execution;
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 64 * 1024);
});

test("game_test validates its composite contract and automation switch before launch approval", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-test-invalid-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const validPlan = {
    target: { mode: "main" },
    steps: [{ type: "wait_frames", frames: 1 }],
  };
  await assert.rejects(
    kernel.execute({
      id: "game-test-disabled",
      name: "game_test",
      arguments: JSON.stringify(validPlan),
    }, context),
    /automation is disabled/i,
  );
  context.runtimeAutomationEnabled = true;
  const invalid = [
    { ...validPlan, cleanup: "sometimes" },
    { ...validPlan, capture: "sometimes" },
    { ...validPlan, capture_max_dimension: 32 },
    { ...validPlan, capture_detail: "auto" },
    { ...validPlan, ready_timeout_ms: 99 },
    { ...validPlan, automation_timeout_ms: 300_001 },
    { ...validPlan, target: { mode: "scene" } },
    { ...validPlan, extra: true },
  ];
  for (const [index, args] of invalid.entries()) {
    await assert.rejects(
      kernel.execute({
        id: `game-test-invalid-${index}`,
        name: "game_test",
        arguments: JSON.stringify(args),
      }, context),
    );
  }
  assert.equal(editorClient.calls.length, 0);
  assert.equal(events.some((event) => event.type.startsWith("approval.")), false);
});

test("game debug status and stop route directly without approval or a scene lease", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-debug-route-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();

  const status = await kernel.execute(
    {
      id: "game-status",
      name: "game_debug_status",
      arguments: "{}",
    },
    context,
  );
  assert.equal(status.ok, true);
  assert.equal(editorClient.calls[0]?.tool, "game_debug_status");
  assert.deepEqual(editorClient.calls[0]?.args, { history_limit: 100, after_seq: 0 });

  const stopped = await kernel.execute(
    {
      id: "game-stop",
      name: "game_debug_stop",
      arguments: JSON.stringify({ run_id: "0123456789abcdef0123456789abcdef" }),
    },
    context,
  );
  assert.equal(stopped.ok, true);
  assert.equal(editorClient.calls[1]?.tool, "game_debug_stop");
  assert.deepEqual(editorClient.calls[1]?.args, {
    run_id: "0123456789abcdef0123456789abcdef",
  });

  for (const call of editorClient.calls) {
    assert.equal(call.context.signal, context.signal);
    assert.equal(call.context.sessionId, context.sessionId);
    assert.equal(call.context.turnId, context.turnId);
    assert.equal(call.context.itemId, context.itemId);
    assert.equal(call.context.sceneLease, undefined);
  }
  assert.equal(events.some((event) => event.type === "approval.requested"), false);
  assert.equal(events.some((event) => event.type === "approval.resolved"), false);
});

test("starting an editor game requires editor_game approval and preserves turn context", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-debug-start-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.approvalMode = "auto";
  const execution = kernel.execute(
    {
      id: "game-start",
      name: "game_debug_start",
      arguments: JSON.stringify({ mode: "scene", scene_path: "demo/debug_scene.tscn" }),
    },
    context,
  );

  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events.map((event) => event.type), ["approval.requested"]);
  const requested = events[0]?.data as {
    request_id: string;
    category: string;
    title: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
  assert.equal(requested.category, "editor_game");
  assert.equal(requested.tool, "game_debug_start");
  assert.match(requested.title, /Start the game/);
  assert.deepEqual(requested.arguments, {
    mode: "scene",
    scene_path: "res://demo/debug_scene.tscn",
  });
  assert.equal(context.approvals.respond(requested.request_id, "accept"), true);

  const result = await execution;
  assert.equal(result.ok, true);
  assert.deepEqual(events.map((event) => event.type), [
    "approval.requested",
    "approval.resolved",
  ]);
  assert.equal(editorClient.calls.length, 1);
  assert.equal(editorClient.calls[0]?.tool, "game_debug_start");
  assert.deepEqual(editorClient.calls[0]?.args, requested.arguments);
  assert.equal(editorClient.calls[0]?.context.signal, context.signal);
  assert.equal(editorClient.calls[0]?.context.sessionId, context.sessionId);
  assert.equal(editorClient.calls[0]?.context.turnId, context.turnId);
  assert.equal(editorClient.calls[0]?.context.itemId, context.itemId);
  assert.equal(editorClient.calls[0]?.context.sceneLease, undefined);
});

test("current game debug target is frozen to the turn's primary scene before approval", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-debug-current-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const execution = kernel.execute(
    {
      id: "game-start-current",
      name: "game_debug_start",
      arguments: JSON.stringify({ mode: "current", scene_path: "/" }),
    },
    context,
  );

  const requested = events[0]?.data as {
    request_id: string;
    arguments: Record<string, unknown>;
  };
  assert.deepEqual(requested.arguments, {
    mode: "scene",
    scene_path: "res://demo/live.tscn",
  });
  assert.equal(context.approvals.respond(requested.request_id, "accept"), true);
  await execution;
  assert.deepEqual(editorClient.calls[0]?.args, requested.arguments);
  assert.equal(editorClient.calls[0]?.context.sceneLease, undefined);
});

test("declined editor game starts do not reach the editor host", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-debug-decline-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const execution = kernel.execute(
    {
      id: "game-start-declined",
      name: "game_debug_start",
      arguments: JSON.stringify({ mode: "main", scene_path: "res://../outside.tscn" }),
    },
    context,
  );
  const requested = events[0]?.data as {
    request_id: string;
    category: string;
    arguments: Record<string, unknown>;
  };
  assert.equal(requested.category, "editor_game");
  assert.deepEqual(requested.arguments, { mode: "main" });
  assert.equal(context.approvals.respond(requested.request_id, "decline"), true);

  assert.deepEqual(await execution, {
    ok: false,
    error: "User declined starting the game in the Godot editor",
  });
  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events.map((event) => event.type), [
    "approval.requested",
    "approval.resolved",
  ]);
});

test("game debug tools reject invalid arguments before approval or editor routing", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-game-debug-invalid-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const invalidCalls = [
    { name: "game_debug_start", args: {}, error: /mode must be one of/ },
    { name: "game_debug_start", args: { mode: "editor" }, error: /mode must be one of/ },
    { name: "game_debug_start", args: { mode: "scene" }, error: /scene_path is required/ },
    {
      name: "game_debug_start",
      args: { mode: "scene", scene_path: 42 },
      error: /scene_path must be a non-empty project scene path/,
    },
    {
      name: "game_debug_start",
      args: { mode: "scene", scene_path: "res:\/\/..\/outside.tscn" },
      error: /project resource tree/,
    },
    {
      name: "game_debug_start",
      args: { mode: "scene", scene_path: "res:\/\/demo\/notes.txt" },
      error: /\.tscn or \.scn/,
    },
    {
      name: "game_debug_start",
      args: { mode: "current", extra: true },
      error: /Unsupported tool argument: extra/,
    },
    { name: "game_debug_status", args: { history_limit: 0 }, error: /between 1 and 500/ },
    { name: "game_debug_status", args: { history_limit: 1.5 }, error: /between 1 and 500/ },
    { name: "game_debug_status", args: { after_seq: -1 }, error: /between 0 and/ },
    { name: "game_debug_status", args: { extra: true }, error: /Unsupported tool argument: extra/ },
    { name: "game_capture_screenshot", args: {}, error: /run_id must be/ },
    { name: "game_capture_screenshot", args: { run_id: AUTOMATION_RUN_ID, max_dimension: 4096 }, error: /between 64 and 2048/ },
    { name: "game_capture_screenshot", args: { run_id: AUTOMATION_RUN_ID, detail: "auto" }, error: /detail must be low or high/ },
    { name: "game_debug_stop", args: {}, error: /run_id must be/ },
    { name: "game_debug_stop", args: { run_id: "short" }, error: /run_id must be/ },
    {
      name: "game_debug_stop",
      args: { run_id: "0123456789abcdef", force: true },
      error: /Unsupported tool argument: force/,
    },
  ];

  for (const [index, invalid] of invalidCalls.entries()) {
    await assert.rejects(
      kernel.execute(
        {
          id: `invalid-game-debug-${index}`,
          name: invalid.name,
          arguments: JSON.stringify(invalid.args),
        },
        context,
      ),
      invalid.error,
    );
  }
  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events, []);
});

test("tool kernel routes validated editor calls with turn context and without approval", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-route-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();

  const result = await kernel.execute(
    {
      id: "call-tree",
      name: "scene_get_tree",
      arguments: JSON.stringify({ max_depth: 3, max_nodes: 40 }),
    },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(editorClient.calls.length, 1);
  assert.deepEqual(editorClient.calls[0]?.args, {
    scene_id: "scene-live-1",
    max_depth: 3,
    max_nodes: 40,
    include_internal: false,
  });
  assert.equal(editorClient.calls[0]?.context.sessionId, context.sessionId);
  assert.equal(editorClient.calls[0]?.context.turnId, context.turnId);
  assert.equal(editorClient.calls[0]?.context.itemId, context.itemId);
  assert.equal(editorClient.calls[0]?.context.signal, context.signal);
  assert.deepEqual(editorClient.calls[0]?.context.sceneLease, {
    scene_id: "scene-live-1",
    scene_path: "res://demo/live.tscn",
    scene_revision: "revision-7",
  });
  assert.equal(events.some((event) => event.type === "approval.requested"), false);

  await kernel.execute(
    {
      id: "call-resource",
      name: "resource_inspect",
      arguments: JSON.stringify({ path: "res://assets/player.tres", include_dependencies: false }),
    },
    context,
  );
  assert.equal(editorClient.calls[1]?.args.path, "assets/player.tres");
  assert.equal(editorClient.calls[1]?.context.sceneLease, undefined);

  await assert.rejects(
    kernel.execute(
      {
        id: "bad-depth",
        name: "scene_get_tree",
        arguments: JSON.stringify({ max_depth: 99 }),
      },
      context,
    ),
    /max_depth must be an integer between 0 and 8/,
  );
  assert.equal(editorClient.calls.length, 2);

  await assert.rejects(
    kernel.execute(
      {
        id: "unique-name",
        name: "node_get_properties",
        arguments: JSON.stringify({ node_path: "HUD/%Score" }),
      },
      context,
    ),
    /root-relative NodePath/,
  );
  assert.equal(editorClient.calls.length, 2);
});

test("editor tools select and advance independent scene leases within each turn", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-multi-scene-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  context.sceneLeases = [
    { scene_id: "scene-a", scene_path: "res://a.tscn", scene_revision: "revision-a1" },
    { scene_id: "scene-b", scene_path: "res://b.tscn", scene_revision: "revision-b4" },
  ];
  context.primarySceneId = "scene-a";
  context.openScenePaths = ["res://a.tscn", "res://b.tscn"];

  await kernel.execute({ id: "tree-primary", name: "scene_get_tree", arguments: "{}" }, context);
  assert.equal(editorClient.calls.at(-1)?.args.scene_id, "scene-a");
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_revision, "revision-a1");

  await kernel.execute(
    { id: "tree-secondary", name: "scene_get_tree", arguments: JSON.stringify({ scene_id: "scene-b" }) },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_id, "scene-b");

  await kernel.execute(
    {
      id: "properties-secondary",
      name: "node_get_properties",
      arguments: JSON.stringify({ scene_id: "scene-b", node_path: "." }),
    },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_id, "scene-b");

  await kernel.execute({ id: "selection-primary", name: "editor_get_selection", arguments: "{}" }, context);
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_id, "scene-a");

  await kernel.execute(
    { id: "resource-unbound", name: "resource_inspect", arguments: JSON.stringify({ path: "res://icon.png" }) },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease, undefined);

  context.approvalMode = "auto";
  editorClient.nextResult = { ok: false, error: "not applied" };
  await kernel.execute(
    {
      id: "failed-a",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-a",
        operations: [{ action: "remove_node", node_path: "Failed" }],
      }),
    },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_revision, "revision-a1");

  await kernel.execute(
    {
      id: "success-b",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-b",
        operations: [{ action: "remove_node", node_path: "B" }],
      }),
    },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.args.scene_revision, "revision-b4");

  await kernel.execute(
    {
      id: "success-a",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-a",
        operations: [{ action: "remove_node", node_path: "A" }],
      }),
    },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.args.scene_revision, "revision-a1");

  await kernel.execute(
    {
      id: "success-b-again",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-b",
        operations: [{ action: "remove_node", node_path: "B2" }],
      }),
    },
    context,
  );
  assert.equal(editorClient.calls.at(-1)?.args.scene_revision, "revision-b4-next");

  const { context: otherTurn } = createToolContext();
  otherTurn.sessionId = context.sessionId;
  otherTurn.turnId = "turn-other";
  otherTurn.sceneLeases = [
    { scene_id: "scene-a", scene_path: "res://a.tscn", scene_revision: "revision-a10" },
  ];
  otherTurn.primarySceneId = "scene-a";
  otherTurn.openScenePaths = ["res://a.tscn"];
  await kernel.execute({ id: "other-turn-tree", name: "scene_get_tree", arguments: "{}" }, otherTurn);
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_revision, "revision-a10");

  const { context: otherSession } = createToolContext();
  otherSession.sessionId = "session-other";
  otherSession.turnId = context.turnId;
  otherSession.sceneLeases = [
    { scene_id: "scene-a", scene_path: "res://a.tscn", scene_revision: "revision-a20" },
  ];
  otherSession.primarySceneId = "scene-a";
  otherSession.openScenePaths = ["res://a.tscn"];
  await kernel.execute({ id: "other-session-tree", name: "scene_get_tree", arguments: "{}" }, otherSession);
  assert.equal(editorClient.calls.at(-1)?.context.sceneLease?.scene_revision, "revision-a20");
});

test("live scene writes bind and advance the matching turn lease revision", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-revision-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  context.approvalMode = "auto";
  editorClient.nextResult = {
    ok: true,
    scene_id: "scene-live-1",
    scene_path: "res://demo/live.tscn",
    scene_revision: "revision-7",
    tree: { name: "Main" },
  };

  const inspected = await kernel.execute(
    { id: "revision-read", name: "scene_get_tree", arguments: "{}" },
    context,
  );
  assert.equal(inspected.scene_revision, "revision-7");

  const firstResult = await kernel.execute(
    {
      id: "revision-write-missing",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-live-1",
        operations: [{ action: "remove_node", node_path: "Icon" }],
      }),
    },
    context,
  );
  assert.equal(firstResult.ok, true);
  assert.equal(editorClient.calls[1]?.args.scene_revision, "revision-7");

  const secondResult = await kernel.execute(
    {
      id: "revision-write-empty",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-live-1",
        scene_revision: "",
        operations: [{ action: "remove_node", node_path: "Icon2" }],
      }),
    },
    context,
  );
  assert.equal(secondResult.ok, true);
  assert.equal(editorClient.calls[2]?.args.scene_revision, "revision-7-next");

  await assert.rejects(
    kernel.execute(
      {
        id: "revision-write-mismatch",
        name: "scene_apply_operations",
        arguments: JSON.stringify({
          scene_id: "scene-live-1",
          scene_revision: "hallucinated-revision",
          operations: [{ action: "remove_node", node_path: "Other" }],
        }),
      },
      context,
    ),
    /scene_revision does not match the scene lease revision for this turn/,
  );
  await assert.rejects(
    kernel.execute(
      {
        id: "revision-write-scene-mismatch",
        name: "scene_apply_operations",
        arguments: JSON.stringify({
          scene_id: "scene-other",
          operations: [{ action: "remove_node", node_path: "Other" }],
        }),
      },
      context,
    ),
    /No editor scene lease is available for scene_id: scene-other/,
  );
  assert.equal(editorClient.calls.length, 3);
});

test("invalid scene reads do not replace or revoke the turn lease", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-invalid-revision-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  editorClient.nextResult = {
    ok: true,
    scene_id: "scene-live-1",
    scene_path: "res://demo/live.tscn",
    scene_revision: "",
  };

  const inspected = await kernel.execute(
    { id: "invalid-revision-read", name: "scene_get_tree", arguments: "{}" },
    context,
  );
  assert.equal(inspected.ok, false);
  assert.match(String(inspected.error), /without a valid scene_id, scene_path, and scene_revision/);
  context.approvalMode = "auto";
  assert.equal(
    (await kernel.execute(
      {
        id: "invalid-revision-write",
        name: "scene_apply_operations",
        arguments: JSON.stringify({
          scene_id: "scene-live-1",
          operations: [{ action: "remove_node", node_path: "Icon" }],
        }),
      },
      context,
    )).ok,
    true,
  );
  assert.equal(editorClient.calls[1]?.args.scene_revision, "revision-7");
});

test("live scene writes require approval and emit structured change events", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-write-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const operations = [
    {
      action: "add_node",
      parent_path: ".",
      node_type: "Label",
      name: "标题 文本",
      properties: { text: "Hello", position: { godot_type: "Vector2", x: 20, y: 30 } },
    },
    {
      action: "set_property",
      node_path: "界面/Status Bar",
      property: "theme_override_colors/font_color",
      value: { godot_type: "Color", r: 1, g: 0.5, b: 0, a: 1 },
    },
    { action: "rename_node", node_path: "标题 文本", new_name: "主标题" },
    { action: "remove_node", node_path: "旧节点" },
  ];
  const execution = kernel.execute(
    {
      id: "write-live-scene",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-live-1",
        scene_revision: "revision-7",
        operations,
      }),
    },
    context,
  );

  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events.map((event) => event.type), [
    "editor_change.proposed",
    "approval.requested",
  ]);
  const proposed = events[0]?.data as {
    change_id: string;
    scene_id: string;
    scene_path: string;
    scene_revision: string;
    changes: unknown[];
    preview: { scene_id: string; scene_path: string; scene_revision: string; changes: unknown[] };
  };
  const requested = events[1]?.data as {
    request_id: string;
    category: string;
    change_id: string;
    preview: { scene_id: string; scene_path: string; scene_revision: string; changes: unknown[] };
  };
  assert.match(proposed.change_id, /^editor_operation_[0-9a-f]{64}$/);
  assert.equal(proposed.scene_id, "scene-live-1");
  assert.equal(proposed.scene_path, "res://demo/live.tscn");
  assert.equal(proposed.scene_revision, "revision-7");
  assert.deepEqual(proposed.changes, operations);
  assert.deepEqual(proposed.preview, {
    scene_id: "scene-live-1",
    scene_path: "res://demo/live.tscn",
    scene_revision: "revision-7",
    changes: operations,
  });
  assert.equal(requested.category, "editor_scene");
  assert.equal(requested.change_id, proposed.change_id);
  assert.deepEqual(requested.preview, proposed.preview);
  assert.equal(context.approvals.respond(requested.request_id, "accept"), true);

  const result = await execution;
  assert.equal(result.ok, true);
  assert.equal(editorClient.calls.length, 1);
  assert.equal(editorClient.calls[0]?.tool, "scene_apply_operations");
  assert.deepEqual(editorClient.calls[0]?.args, {
    scene_id: "scene-live-1",
    scene_revision: "revision-7",
    operations,
    operation_id: proposed.change_id,
  });
  assert.equal(editorClient.calls[0]?.context.signal, context.signal);
  assert.deepEqual(events.map((event) => event.type), [
    "editor_change.proposed",
    "approval.requested",
    "approval.resolved",
    "editor_change.applied",
  ]);
  const applied = events[3]?.data as {
    change_id: string;
    operation_id: string;
    scene_id: string;
    scene_revision: string;
    previous_scene_revision: string;
    changes: unknown[];
    requested_changes: unknown[];
  };
  assert.equal(applied.change_id, proposed.change_id);
  assert.equal(applied.operation_id, proposed.change_id);
  assert.equal(applied.scene_id, "scene-live-1");
  assert.equal(applied.scene_revision, "revision-7-next");
  assert.equal(applied.previous_scene_revision, "revision-7");
  assert.deepEqual(applied.changes, operations);
  assert.deepEqual(applied.requested_changes, operations);
});

test("declined live scene writes never call the editor bridge", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-decline-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const execution = kernel.execute(
    {
      id: "decline-live-scene",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-live-1",
        scene_revision: "revision-7",
        operations: [{ action: "remove_node", node_path: "Obsolete" }],
      }),
    },
    context,
  );
  const requested = events.find((event) => event.type === "approval.requested")?.data as {
    request_id: string;
  };
  assert.equal(context.approvals.respond(requested.request_id, "decline"), true);

  assert.deepEqual(await execution, { ok: false, error: "User declined the editor scene change" });
  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events.map((event) => event.type), [
    "editor_change.proposed",
    "approval.requested",
    "approval.resolved",
  ]);
});

test("phase three live scene operations and tagged values are normalized before reaching Godot", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-phase-three-")));
  const editorClient = new FakeEditorToolClient();
  const actualChanges = [{ action: "modified", node_path: "HUD/Icon2", property: "texture" }];
  const expectedResult = {
    ok: true,
    scene_id: "scene-live-1",
    scene_path: "res://demo/live.tscn",
    previous_scene_revision: "revision-7",
    scene_revision: "revision-8",
    changes: actualChanges,
  };
  editorClient.nextResult = expectedResult;
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.approvalMode = "auto";
  const operations = [
    {
      action: "set_property",
      node_path: "HUD/Icon",
      property: "texture",
      value: {
        godot_type: "Resource",
        path: "res://assets/icon.png",
        expected_type: "Texture2D",
        resource_type: "CompressedTexture2D",
        name: "Icon",
        uid: "uid://abc123",
      },
    },
    {
      action: "set_property",
      node_path: "HUD/Follow",
      property: "target_path",
      value: { godot_type: "NodePath", path: "HUD/Icon" },
    },
    { action: "duplicate_node", node_path: "HUD/Icon", parent_path: "HUD", name: "Icon2" },
    { action: "reparent_node", node_path: "HUD/Icon2", new_parent_path: ".", index: 0 },
    {
      action: "instantiate_scene",
      parent_path: ".",
      scene_path: "res://actors/player.tscn",
      name: "Player2",
      properties: {
        portrait: {
          godot_type: "Resource",
          path: "res://assets/portrait.png",
          expected_type: "Texture2D",
        },
        material: {
          godot_type: "Resource",
          uid: "uid://material9",
          expected_type: "Material",
        },
        focus_path: { godot_type: "NodePath", path: "" },
      },
    },
    {
      action: "set_property",
      node_path: "Stats",
      property: "total_ticks",
      value: { godot_type: "int64", value: "9223372036854775807" },
    },
    {
      action: "set_property",
      node_path: "Camera",
      property: "projection_row",
      value: { godot_type: "Vector4", x: 1.25, y: -2.5, z: 0, w: 4 },
    },
    {
      action: "set_property",
      node_path: "Grid",
      property: "cell_bounds",
      value: {
        godot_type: "Vector4i",
        x: -2_147_483_648,
        y: 2.0,
        z: 0,
        w: 2_147_483_647,
      },
    },
    {
      action: "set_script",
      node_path: "Board",
      script_path: "res://scripts/board.gd",
    },
    {
      action: "set_property",
      node_path: "Stats",
      property: "roundtrip_values",
      value: [
        { godot_type: "int64", value: "-9223372036854775808" },
        { godot_type: "Vector4", x: 1, y: 2, z: 3, w: 4 },
        { godot_type: "Vector4i", x: -1, y: 0, z: 1, w: 2 },
      ],
    },
  ];

  const result = await kernel.execute(
    {
      id: "phase-three-live",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-live-1",
        scene_revision: "revision-7",
        operations,
      }),
    },
    context,
  );

  assert.deepEqual(result, expectedResult);
  const forwarded = editorClient.calls[0]?.args;
  assert.equal(forwarded?.scene_revision, "revision-7");
  const forwardedOperations = forwarded?.operations as Array<Record<string, unknown>>;
  assert.deepEqual((forwardedOperations[0]?.value as Record<string, unknown>), {
    godot_type: "Resource",
    path: "res://assets/icon.png",
    expected_type: "Texture2D",
    uid: "uid://abc123",
  });
  assert.deepEqual(forwardedOperations[1]?.value, { godot_type: "NodePath", path: "HUD/Icon" });
  assert.equal(forwardedOperations[3]?.keep_global_transform, true);
  assert.deepEqual(forwardedOperations[5]?.value, {
    godot_type: "int64",
    value: "9223372036854775807",
  });
  assert.deepEqual(forwardedOperations[6]?.value, {
    godot_type: "Vector4",
    x: 1.25,
    y: -2.5,
    z: 0,
    w: 4,
  });
  assert.deepEqual(forwardedOperations[7]?.value, {
    godot_type: "Vector4i",
    x: -2_147_483_648,
    y: 2,
    z: 0,
    w: 2_147_483_647,
  });
  assert.deepEqual(forwardedOperations[8], {
    action: "set_script",
    node_path: "Board",
    script_path: "res://scripts/board.gd",
  });
  assert.deepEqual(forwardedOperations[9]?.value, [
    { godot_type: "int64", value: "-9223372036854775808" },
    { godot_type: "Vector4", x: 1, y: 2, z: 3, w: 4 },
    { godot_type: "Vector4i", x: -1, y: 0, z: 1, w: 2 },
  ]);
  const applied = events.find((event) => event.type === "editor_change.applied")?.data as {
    scene_revision: string;
    previous_scene_revision: string;
    changes: unknown[];
    requested_changes: unknown[];
  };
  assert.equal(applied.scene_revision, "revision-8");
  assert.equal(applied.previous_scene_revision, "revision-7");
  assert.deepEqual(applied.changes, actualChanges);
  assert.deepEqual(applied.requested_changes, forwardedOperations);
});

test("live scene write validation is strict and happens before approval", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-validate-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  const invalidCases: Array<{ arguments: Record<string, unknown>; pattern: RegExp }> = [
    {
      arguments: { operations: [{ action: "remove_node", node_path: "Old" }] },
      pattern: /scene_id must be a non-empty safe string/,
    },
    {
      arguments: {
        scene_id: "scene-unleased",
        operations: [{ action: "remove_node", node_path: "Old" }],
      },
      pattern: /No editor scene lease is available for scene_id: scene-unleased/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "remove_node", node_path: "Old" }],
        unexpected: true,
      },
      pattern: /Unsupported tool argument: unexpected/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "add_node", parent_path: "/Root", node_type: "Label", name: "Title" }],
      },
      pattern: /parent_path.*root-relative NodePath/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_property", node_path: "Title", property: "name", value: "Other" }],
      },
      pattern: /protected structural or script property name/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_property", node_path: "Title", property: "script/source_code", value: "x" }],
      },
      pattern: /use action set_script/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_script", node_path: "Title", script_path: "res://scripts/title.txt" }],
      },
      pattern: /GDScript path ending in \.gd/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_property", node_path: "Title", property: "scene_unique_id/value", value: 1 }],
      },
      pattern: /protected structural or script property scene_unique_id/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_property", node_path: "Title", property: "text", value: { nested: true } }],
      },
      pattern: /supported JSON-safe Godot value/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "set_property", node_path: "Title", property: "z_index", value: 9_007_199_254_740_992 }],
      },
      pattern: /safe integer/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Title",
          property: "position",
          value: { godot_type: "Vector2i", x: 2_147_483_648, y: 0 },
        }],
      },
      pattern: /signed 32-bit integer/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Stats",
          property: "total_ticks",
          value: { godot_type: "int64", value: 0 },
        }],
      },
      pattern: /canonical signed decimal int64 string/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Stats",
          property: "total_ticks",
          value: { godot_type: "int64", value: "01" },
        }],
      },
      pattern: /canonical signed decimal int64 string/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Stats",
          property: "total_ticks",
          value: { godot_type: "int64", value: "-0" },
        }],
      },
      pattern: /canonical signed decimal int64 string/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Stats",
          property: "total_ticks",
          value: { godot_type: "int64", value: "9223372036854775808" },
        }],
      },
      pattern: /within the signed 64-bit range/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Stats",
          property: "total_ticks",
          value: { godot_type: "int64", value: "-9223372036854775809" },
        }],
      },
      pattern: /within the signed 64-bit range/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Camera",
          property: "projection_row",
          value: { godot_type: "Vector4", x: 1, y: 2, z: 3 },
        }],
      },
      pattern: /value\.w must be a finite number/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Grid",
          property: "cell_bounds",
          value: { godot_type: "Vector4i", x: -2_147_483_649, y: 0, z: 0, w: 0 },
        }],
      },
      pattern: /signed 32-bit integer/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Grid",
          property: "cell_bounds",
          value: { godot_type: "Vector4i", x: 0, y: 0, z: 0, w: 1.5 },
        }],
      },
      pattern: /signed 32-bit integer/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "remove_node", node_path: "Old", force: true }],
      },
      pattern: /unsupported field: force/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Icon",
          property: "texture",
          value: { godot_type: "Resource", path: "res://../secret.png" },
        }],
      },
      pattern: /stay within the res:\/\/ project resource tree/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Icon",
          property: "texture",
          value: {
            godot_type: "Resource",
            path: "res://icon.png",
            expected_type: "Texture2D<script>",
            resource_type: "CompressedTexture2D",
          },
        }],
      },
      pattern: /expected_type must be a safe Godot identifier/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Icon",
          property: "texture",
          value: { godot_type: "Resource", expected_type: "Texture2D" },
        }],
      },
      pattern: /Resource requires a res:\/\/ path, uid:\/\/ UID, or both/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Icon",
          property: "texture",
          value: { godot_type: "Resource", uid: "123456789" },
        }],
      },
      pattern: /Godot uid:\/\/ format/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Follow",
          property: "target_path",
          value: { godot_type: "NodePath", path: "/root/Outside" },
        }],
      },
      pattern: /current-scene root-relative NodePath/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "set_property",
          node_path: "Follow",
          property: "targets",
          value: [{ godot_type: "NodePath", path: "Target" }],
        }],
      },
      pattern: /Resource and NodePath tags are only supported as scalar properties/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "instantiate_scene",
          parent_path: ".",
          scene_path: "uid://abc",
        }],
      },
      pattern: /must be a res:\/\/ project resource path/,
    },
    {
      arguments: {
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{
          action: "reparent_node",
          node_path: "Child",
          new_parent_path: ".",
          index: -1,
        }],
      },
      pattern: /index must be an integer between 0 and 1000000/,
    },
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    await assert.rejects(
      kernel.execute(
        {
          id: `invalid-live-${index}`,
          name: "scene_apply_operations",
          arguments: JSON.stringify(invalid.arguments),
        },
        context,
      ),
      invalid.pattern,
    );
  }

  const oversizedOperations = Array.from({ length: 33 }, (_, operationIndex) => ({
    action: "add_node",
    parent_path: ".",
    node_type: "Node",
    name: `Node${operationIndex}`,
    properties: Object.fromEntries(
      Array.from({ length: 32 }, (_, propertyIndex) => [`property_${propertyIndex}`, "x".repeat(1000)]),
    ),
  }));
  await assert.rejects(
    kernel.execute(
      {
        id: "oversized-live",
        name: "scene_apply_operations",
        arguments: JSON.stringify({
          scene_id: "scene-1",
          scene_revision: "revision-1",
          operations: oversizedOperations,
        }),
      },
      context,
    ),
    /normalized request exceeds the 512 KiB limit/,
  );
  assert.equal(editorClient.calls.length, 0);
  assert.deepEqual(events, []);
});

test("live scene writes require an explicit successful bridge result", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-result-")));
  const editorClient = new FakeEditorToolClient();
  editorClient.nextResult = { applied: 1 };
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context, events } = createToolContext();
  context.approvalMode = "auto";

  const result = await kernel.execute(
    {
      id: "invalid-editor-result",
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-1",
        scene_revision: "revision-1",
        operations: [{ action: "remove_node", node_path: "Obsolete" }],
      }),
    },
    context,
  );

  assert.deepEqual(result, { ok: false, error: "Godot editor bridge returned an invalid scene change result" });
  assert.equal(editorClient.calls.length, 1);
  assert.equal(events.some((event) => event.type === "editor_change.applied"), false);
});

test("live scene success results must preserve scene and revision causality", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-causality-")));
  const invalidResults: Array<{ result: Record<string, unknown>; error: string }> = [
    {
      result: {
        ok: true,
        scene_id: "scene-other",
        scene_path: "res://demo/one.tscn",
        previous_scene_revision: "revision-1",
        scene_revision: "revision-2",
      },
      error: "Godot editor bridge returned a result for a different scene",
    },
    {
      result: {
        ok: true,
        scene_id: "scene-1",
        scene_path: "res://demo/one.tscn",
        previous_scene_revision: "revision-stale",
        scene_revision: "revision-2",
      },
      error: "Godot editor bridge returned a mismatched previous scene revision",
    },
    {
      result: {
        ok: true,
        scene_id: "scene-1",
        scene_path: "res://demo/one.tscn",
        previous_scene_revision: "revision-1",
      },
      error: "Godot editor bridge returned an invalid new scene revision",
    },
  ];

  for (const [index, invalid] of invalidResults.entries()) {
    const editorClient = new FakeEditorToolClient();
    editorClient.nextResult = invalid.result;
    const kernel = new ToolRegistry(workspace, { editorClient });
    const { context, events } = createToolContext();
    context.approvalMode = "auto";
    const result = await kernel.execute(
      {
        id: `invalid-causality-${index}`,
        name: "scene_apply_operations",
        arguments: JSON.stringify({
          scene_id: "scene-1",
          scene_revision: "revision-1",
          operations: [{ action: "remove_node", node_path: "Obsolete" }],
        }),
      },
      context,
    );
    assert.deepEqual(result, { ok: false, error: invalid.error });
    assert.equal(events.some((event) => event.type === "editor_change.applied"), false);
  }
});

test("live scene operation bindings never replay an older revision and differ across turns", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-editor-idempotency-")));
  const editorClient = new FakeEditorToolClient();
  const kernel = new ToolRegistry(workspace, { editorClient });
  const { context } = createToolContext();
  context.approvalMode = "auto";
  const call = (properties: Record<string, unknown>, sceneRevision: string | null = "revision-1") => kernel.execute(
    {
      id: `retry-${editorClient.calls.length}`,
      name: "scene_apply_operations",
      arguments: JSON.stringify({
        scene_id: "scene-1",
        ...(sceneRevision !== null ? { scene_revision: sceneRevision } : {}),
        operations: [{ action: "add_node", parent_path: ".", node_type: "Node", name: "Child", properties }],
      }),
    },
    context,
  );

  await call({ z_index: 2, visible: true });
  await assert.rejects(
    call({ visible: true, z_index: 2 }),
    /already bound to an earlier revision/,
  );
  assert.equal(editorClient.calls.length, 1);
  const firstOperationId = editorClient.calls[0]?.args.operation_id;
  context.turnId = "turn-next";
  await call({ visible: true, z_index: 2 }, null);
  assert.notEqual(firstOperationId, editorClient.calls[1]?.args.operation_id);
});

test("tool registry rejects duplicate definitions", async () => {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-duplicate-tool-")));
  const kernel = new ToolRegistry(workspace);
  assert.throws(
    () => kernel.register({
      schema: { name: "list_files", description: "duplicate", parameters: {} },
      executor: "runtime",
      effect: "read",
      execute: () => ({ ok: true }),
    }),
    /already registered/,
  );
});

function createToolContext(): { context: ToolContext; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  const factory = new EventFactory();
  const context: ToolContext = {
    sessionId: "session",
    turnId: "turn",
    itemId: "item",
    sceneLeases: [
      {
        scene_id: "scene-live-1",
        scene_path: "res://demo/live.tscn",
        scene_revision: "revision-7",
      },
      {
        scene_id: "scene-1",
        scene_path: "res://demo/one.tscn",
        scene_revision: "revision-1",
      },
    ],
    primarySceneId: "scene-live-1",
    openScenePaths: ["res://demo/live.tscn", "res://demo/one.tscn"],
    runtimeAutomationEnabled: false,
    approvalMode: "ask",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => {
      const event = factory.create(type, data, {
        sessionId: "session",
        turnId: "turn",
        ...(itemId ? { itemId } : {}),
      });
      events.push(event);
      return event;
    },
  };
  return { context, events };
}
