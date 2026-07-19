import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSchema } from "../src/provider/types.js";
import { extractUserRequest, routeTools } from "../src/tool-router.js";

const ALL_TOOL_NAMES = [
  "web_search",
  "web_open",
  "project_symbol_search",
  "project_find_references",
  "project_dependency_graph",
  "list_files",
  "read_file",
  "search_text",
  "apply_patch",
  "godot_scene",
  "run_command",
  "godot_api_query",
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
] as const;

const DEFINITIONS = ALL_TOOL_NAMES.map(toolSchema);
const SEMANTIC_READ = ["project_symbol_search", "project_find_references", "project_dependency_graph"];
const BASE = ["list_files", "read_file", "search_text"];
const EDITOR_READ = ["godot_api_query", "scene_get_tree", "editor_get_selection", "node_get_properties", "resource_inspect"];
const GAME_DEBUG = [
  "game_debug_start",
  "game_debug_status",
  "game_capture_screenshot",
  "game_debug_stop",
];
const GAME_AUTOMATION = [
  "game_automation_run",
  "game_automation_status",
  "game_automation_cancel",
];
const GAME_ATOMIC = [...GAME_DEBUG, ...GAME_AUTOMATION];

test("tool router isolates the Godot user request and routes Chinese and English code tasks", () => {
  const wrapped = `<godot_editor_context>\ncurrent_scene: demo/main.tscn\ncurrent_script: demo/main.gd\n</godot_editor_context>\n\nUser request:\n修复 scripts/player.gd 的报错`;
  assert.equal(extractUserRequest(wrapped), "修复 scripts/player.gd 的报错");

  for (const prompt of [wrapped, "Fix the error in scripts/player.gd"]) {
    const result = route(prompt);
    assert.equal(result.profile, "code");
    assert.deepEqual(result.toolNames, [...SEMANTIC_READ, ...BASE, "apply_patch", "run_command", "godot_api_query"]);
    assert.equal(result.toolNames.some((name) => name.startsWith("scene_")), false);
    assert.equal(result.toolNames.some((name) => name.startsWith("game_")), false);
    assert.equal(result.toolNames.some((name) => name.startsWith("web_")), false);
  }

  for (const prompt of ["运行测试", "npm test"]) {
    const result = route(prompt);
    assert.equal(result.profile, "code");
    assert.deepEqual(result.toolNames, [...SEMANTIC_READ, ...BASE, "run_command", "godot_api_query"]);
  }
});

test("semantic requests publish project index and live Godot API tools", () => {
  for (const prompt of ["查找 PlayerController 的引用和依赖关系", "Where is PlayerController defined?"]) {
    const result = route(prompt);
    assertIncludes(result.toolNames, [...SEMANTIC_READ, ...BASE, "godot_api_query"]);
    assertExcludes(result.toolNames, ["apply_patch", "run_command", "scene_apply_operations"]);
  }
});

test("tool router separates live scene inspection, live writes, and closed scene writes", () => {
  const inspect = route("查看当前场景节点树", {
    openScenePaths: ["demo/main.tscn"],
    hasSceneLeases: true,
  });
  assert.equal(inspect.profile, "scene");
  assertIncludes(inspect.toolNames, [...SEMANTIC_READ, ...BASE, ...EDITOR_READ]);
  assertExcludes(inspect.toolNames, ["scene_apply_operations", "godot_scene", "apply_patch"]);

  const liveWrite = route("在当前场景增加 Label", {
    openScenePaths: ["demo/main.tscn"],
    hasSceneLeases: true,
  });
  assertIncludes(liveWrite.toolNames, [...SEMANTIC_READ, ...BASE, ...EDITOR_READ, "scene_apply_operations"]);
  assertExcludes(liveWrite.toolNames, ["godot_scene", "apply_patch"]);

  const closedWrite = route("Add a Label to scenes/credits.tscn", {
    openScenePaths: ["demo/main.tscn"],
    hasSceneLeases: true,
  });
  assertIncludes(closedWrite.toolNames, [...SEMANTIC_READ, ...BASE, "godot_scene", "resource_inspect"]);
  assertExcludes(closedWrite.toolNames, ["scene_apply_operations", "scene_get_tree"]);
});

test("an open scene path without a usable lease never falls back to text scene writes", () => {
  const result = route("修改 demo/main.tscn 的 Title", {
    openScenePaths: ["res://demo/main.tscn"],
    hasSceneLeases: false,
  });
  assert.equal(result.profile, "scene");
  assert.ok(result.toolNames.includes("scene_apply_operations"));
  assert.equal(result.toolNames.includes("godot_scene"), false);
});

test("fresh game verification publishes game_test while atomic control stays separate", () => {
  const fresh = route("Verify the current game locally", { runtimeAutomationEnabled: true });
  assert.equal(fresh.profile, "game");
  assert.deepEqual(fresh.toolNames, [...BASE, "game_test"]);
  assertExcludes(fresh.toolNames, GAME_ATOMIC);

  const atomic = route("Run UI automation", { runtimeAutomationEnabled: true });
  assert.ok(atomic.profile === "game" || atomic.profile === "mixed");
  assertIncludes(atomic.toolNames, [...BASE, ...GAME_AUTOMATION]);
  assertExcludes(atomic.toolNames, [...GAME_DEBUG, "game_test"]);

  for (const prompt of ["运行当前场景", "Run the current scene"]) {
    const launch = route(prompt, { runtimeAutomationEnabled: true });
    assertIncludes(launch.toolNames, GAME_DEBUG);
    assertExcludes(launch.toolNames, [...GAME_AUTOMATION, "game_test"]);
  }

  const composite = route("运行当前场景并点击按钮验证结果", { runtimeAutomationEnabled: true });
  assert.ok(composite.toolNames.includes("game_test"));
  assertExcludes(composite.toolNames, GAME_ATOMIC);
});

test("running game screenshot requests route the bound visual capture tool", () => {
  for (const prompt of ["Capture the running game screenshot", "截取当前游戏运行画面做视觉检查"]) {
    const result = route(prompt, { runtimeAutomationEnabled: false });
    assert.ok(result.profile === "game" || result.profile === "mixed");
    assertIncludes(result.toolNames, [...BASE, ...GAME_DEBUG]);
    assert.equal(result.toolNames.includes("game_capture_screenshot"), true);
  }
});

test("tool router unions web, code, scene, and game capabilities", () => {
  const webCode = route("查官方文档并修复 scripts/player.gd");
  assert.equal(webCode.profile, "mixed");
  assertIncludes(webCode.toolNames, [...BASE, "apply_patch", "run_command", "web_search", "web_open"]);

  const mixed = route("修改脚本和当前场景，然后运行场景测试", {
    runtimeAutomationEnabled: true,
    openScenePaths: ["demo/main.tscn"],
    hasSceneLeases: true,
  });
  assert.equal(mixed.profile, "mixed");
  assertIncludes(mixed.toolNames, [
    ...BASE,
    "apply_patch",
    "run_command",
    ...EDITOR_READ,
    "scene_apply_operations",
    "game_test",
  ]);
});

test("explicit external searches publish web tools while project searches stay local", () => {
  for (const prompt of [
    "搜索一下 Steam 前 10 的游戏",
    "搜一下 Steam 实时热门游戏",
    "Search for the top 10 games on Steam",
  ]) {
    const result = route(prompt);
    assert.equal(result.profile, "web");
    assertIncludes(result.toolNames, [...BASE, "web_search", "web_open"]);
  }

  for (const prompt of ["搜索项目中的 Title", "查一下 demo/main.gd 的错误"]) {
    const result = route(prompt);
    assert.equal(result.toolNames.includes("web_search"), false);
    assert.equal(result.toolNames.includes("web_open"), false);
  }
});

test("explicit read-only and no-game requests remain hard policy restrictions", () => {
  const readOnly = route("不要修改，只告诉我失败原因", { runtimeAutomationEnabled: true });
  assertExcludes(readOnly.toolNames, ["apply_patch", "run_command", "godot_scene", "scene_apply_operations"]);
  assertExcludes(readOnly.policyToolNames, [
    "apply_patch",
    "run_command",
    "godot_scene",
    "scene_apply_operations",
    "game_debug_start",
    "game_debug_stop",
    "game_automation_run",
    "game_automation_cancel",
    "game_test",
  ]);

  const noGame = route("不要运行游戏，只检查节点", {
    runtimeAutomationEnabled: true,
    hasSceneLeases: true,
  });
  assertIncludes(noGame.toolNames, EDITOR_READ);
  assert.equal(noGame.policyToolNames.some((name) => name.startsWith("game_")), false);
});

test("ambiguous follow-ups use the policy-filtered full set", () => {
  for (const prompt of ["继续", "按刚才方案做", "fix it"]) {
    const result = route(prompt, { runtimeAutomationEnabled: false });
    assert.equal(result.profile, "full");
    assert.deepEqual(result.toolNames, result.policyToolNames);
    assertExcludes(result.toolNames, ["game_test", "game_automation_run", "game_automation_cancel"]);
    assert.ok(result.toolNames.includes("game_automation_status"));
  }
});

test("greetings and planning questions keep only bounded project reads", () => {
  for (const prompt of ["HI", "下一步该做什么", "这个问题有什么优化方案"]) {
    const result = route(prompt, { runtimeAutomationEnabled: false });
    assert.equal(result.profile, "read");
    assert.deepEqual(result.toolNames, BASE);
  }
});

test("routing preserves registry order, removes duplicates, and cannot invent editor tools", () => {
  const definitionsWithoutEditor = DEFINITIONS.filter((definition) => (
    !definition.name.startsWith("scene_") &&
    !definition.name.startsWith("editor_") &&
    !definition.name.startsWith("node_") &&
    definition.name !== "godot_api_query" &&
    definition.name !== "resource_inspect" &&
    !definition.name.startsWith("game_")
  ));
  const result = routeTools({
    prompt: "在当前场景增加 Label",
    definitions: definitionsWithoutEditor,
    runtimeAutomationEnabled: true,
    hasSceneLeases: true,
  });
  assert.equal(result.toolNames.some((name) => EDITOR_READ.includes(name) || name.startsWith("game_")), false);
  assert.equal(new Set(result.toolNames).size, result.toolNames.length);
  assert.deepEqual(
    result.toolNames,
    definitionsWithoutEditor.filter((definition) => result.toolNames.includes(definition.name)).map((definition) => definition.name),
  );
});

function route(
  prompt: string,
  options: {
    runtimeAutomationEnabled?: boolean;
    openScenePaths?: readonly string[];
    hasSceneLeases?: boolean;
  } = {},
) {
  return routeTools({
    prompt,
    definitions: DEFINITIONS,
    runtimeAutomationEnabled: options.runtimeAutomationEnabled ?? true,
    ...(options.openScenePaths !== undefined ? { openScenePaths: options.openScenePaths } : {}),
    ...(options.hasSceneLeases !== undefined ? { hasSceneLeases: options.hasSceneLeases } : {}),
  });
}

function toolSchema(name: string): ToolSchema {
  return { name, description: `${name} test schema`, parameters: { type: "object" } };
}

function assertIncludes(actual: readonly string[], expected: readonly string[]): void {
  for (const name of expected) assert.ok(actual.includes(name), `Expected tool ${name} in ${actual.join(", ")}`);
}

function assertExcludes(actual: readonly string[], excluded: readonly string[]): void {
  for (const name of excluded) assert.equal(actual.includes(name), false, `Unexpected tool ${name}`);
}
