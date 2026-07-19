import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime, type TurnOptions } from "../src/agent.js";
import { AttachmentStore } from "../src/attachment-store.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderTurnResult,
  ToolCall,
  ToolSchema,
} from "../src/provider/types.js";
import type { RuntimeEvent } from "../src/protocol.js";
import { SessionStore } from "../src/session-store.js";
import { SkillRegistry } from "../src/skills.js";
import type { ToolContext, ToolKernel } from "../src/tool-kernel.js";
import { ToolRegistry } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

class ScriptedProvider implements ModelProvider {
  calls = 0;
  requests: ProviderRequest[] = [];

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "scripted" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_edit",
              name: "apply_patch",
              arguments: JSON.stringify({
                operations: [
                  {
                    action: "replace",
                    path: "target.gd",
                    old_text: '"Before"',
                    new_text: '"After"',
                  },
                ],
              }),
            },
          ],
        },
      };
    }

    const toolResult = request.messages.at(-1);
    assert.equal(toolResult?.role, "tool");
    if (toolResult?.role === "tool") assert.equal(JSON.parse(toolResult.content).ok, true);
    request.onEvent({ type: "text_delta", text: "H" });
    await Promise.resolve();
    request.onEvent({ type: "text_delta", text: "I" });
    return { message: { role: "assistant", content: "HI", toolCalls: [] } };
  }
}

test("agent performs an approved tool loop and streams before completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-agent-"));
  await writeFile(path.join(root, "target.gd"), 'const VALUE = "Before"\n');
  const provider = new ScriptedProvider();
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new ToolRegistry(await Workspace.open(root, ["target.gd"])),
    model: "scripted",
    approvalMode: "auto",
    emit: (event) => events.push(event),
  });
  const sessionId = runtime.createSession();
  const turnOptions: TurnOptions = {
    model: "scripted-override",
    reasoningEffort: "high",
    sceneLeases: [{
      scene_id: "scene-main",
      scene_path: "res://main.tscn",
      scene_revision: "revision-main-1",
    }],
    primarySceneId: "scene-main",
    openScenePaths: ["res://main.tscn"],
    runtimeAutomationEnabled: true,
  };
  const turn = runtime.runTurn(sessionId, "Edit target.gd then say HI", turnOptions);
  turnOptions.reasoningEffort = "low";
  await turn;

  assert.equal(provider.calls, 2);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /hosted inside an already-running Godot Editor/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Never launch or invoke godot, godot4/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /For mode=current, omit scene_path/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Runtime binds the primary scene frozen when the turn started/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /freezes zero or more open editor scene targets/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Every listed open scene path is protected/);
  assert.match(
    provider.requests[0]?.systemPrompt ?? "",
    /Never use git, Python, or run_command merely to discover, read, list, or search project files/,
  );
  assert.match(
    provider.requests[0]?.systemPrompt ?? "",
    /do not call cat, type, Get-Content, ls, dir, grep, find, or rg/,
  );
  assert.match(provider.requests[0]?.systemPrompt ?? "", /workspace tools include untracked files and are authoritative/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Keep Godot property maps flat/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /brief, concrete progress update/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Match the language of the user's latest request/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Runtime game automation is enabled for this turn/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /Prefer game_test/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /waits for readiness and completion locally/);
  assert.match(provider.requests[0]?.systemPrompt ?? "", /do not call game_debug_status or game_automation_status merely to poll/);
  assert.doesNotMatch(provider.requests[0]?.systemPrompt ?? "", /Runtime game automation is disabled for this turn/);
  assert.deepEqual(provider.requests.map((request) => request.model), ["scripted-override", "scripted-override"]);
  assert.deepEqual(provider.requests.map((request) => request.reasoningEffort), ["high", "high"]);
  const expectedCodeTools = ["list_files", "read_file", "search_text", "apply_patch", "run_command"];
  assert.deepEqual(
    provider.requests.map((request) => request.tools.map((tool) => tool.name)),
    [expectedCodeTools, expectedCodeTools],
  );
  assert.match(provider.requests[0]?.systemPrompt ?? "", /selected the "code" tool profile/);
  assert.doesNotThrow(() =>
    runtime.validateTurn(sessionId, "next", { model: "provider-owned-model", reasoningEffort: "custom" }),
  );
  assert.throws(() => runtime.validateTurn(sessionId, "next", { reasoningEffort: " bad " }), /Invalid/);
  assert.throws(
    () => runtime.validateTurn(sessionId, "next", {
      sceneLeases: [
        { scene_id: "duplicate", scene_path: "res://a.tscn", scene_revision: "revision-a" },
        { scene_id: "duplicate", scene_path: "res://b.tscn", scene_revision: "revision-b" },
      ],
    }),
    /duplicate scene_id/,
  );
  assert.throws(
    () => runtime.validateTurn(sessionId, "next", {
      sceneLeases: [],
      primarySceneId: "missing",
    }),
    /must identify a scene/,
  );
  assert.throws(
    () => runtime.validateTurn(sessionId, "next", { openScenePaths: ["main.tscn"] }),
    /canonical res:\/\/ path/,
  );
  assert.equal(await readFile(path.join(root, "target.gd"), "utf8"), 'const VALUE = "After"\n');
  const turnStarted = events.find((event) => event.type === "turn.started")?.data as {
    scene_leases: unknown[];
    primary_scene_id: string | null;
    open_scene_paths: string[];
    runtime_automation_enabled: boolean;
    tool_profile: string;
    tool_names: string[];
    tool_count: number;
    tool_schema_bytes: number;
    full_tool_schema_bytes: number;
  };
  assert.deepEqual(turnStarted.scene_leases, [{
    scene_id: "scene-main",
    scene_path: "res://main.tscn",
    scene_revision: "revision-main-1",
  }]);
  assert.equal(turnStarted.primary_scene_id, "scene-main");
  assert.deepEqual(turnStarted.open_scene_paths, ["res://main.tscn"]);
  assert.equal(turnStarted.runtime_automation_enabled, true);
  assert.equal(turnStarted.tool_profile, "code");
  assert.deepEqual(turnStarted.tool_names, expectedCodeTools);
  assert.equal(turnStarted.tool_count, expectedCodeTools.length);
  assert.ok(turnStarted.tool_schema_bytes < turnStarted.full_tool_schema_bytes);
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("tool.started") < types.indexOf("approval.requested"));
  assert.ok(types.indexOf("approval.requested") < types.indexOf("file_change.applied"));
  assert.ok(types.indexOf("file_change.applied") < types.indexOf("tool.completed"));
  assert.ok(types.indexOf("message.delta") < types.lastIndexOf("message.completed"));
  assert.ok(types.lastIndexOf("message.completed") < types.indexOf("turn.completed"));
  assert.equal(
    events.filter((event) => event.type === "message.delta").map((event) => (event.data as { delta: string }).delta).join(""),
    "HI",
  );
});

test("agent injects tool image observations after function outputs on the next provider step", async () => {
  const image = makeAgentTestPngHeader(32, 32);
  const attachmentId = createHash("sha256").update(image).digest("hex");
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    async listModels() {
      return [{ id: "scripted" }];
    },
    async streamTurn(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_visual", name: "read_file", arguments: '{"path":"frame.png"}' }],
          },
        };
      }
      return { message: { role: "assistant", content: "done", toolCalls: [] } };
    },
  };
  const tools: ToolKernel = {
    definitions: () => [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    async execute() {
      return { ok: true };
    },
    async executeWithObservations() {
      return {
        output: { ok: true, attachment_id: attachmentId },
        observations: [{
          type: "image",
          attachmentId,
          mimeType: "image/png",
          detail: "low",
        }],
      };
    },
  };
  const attachmentDirectory = await mkdtemp(path.join(tmpdir(), "godetx-agent-observation-"));
  await writeFile(path.join(attachmentDirectory, `${attachmentId}.png`), image);
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "scripted",
    attachmentStore: new AttachmentStore(attachmentDirectory),
    emit: () => undefined,
  });
  const sessionId = runtime.createSession();

  await runtime.runTurn(sessionId, "Read the file and inspect its frame");

  assert.deepEqual(requests[1]?.messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  const observation = requests[1]?.messages.at(-1);
  assert.equal(observation?.role === "user" ? observation.synthetic?.kind : "", "tool_observation");
  assert.equal(
    observation?.role === "user" && Array.isArray(observation.content)
      ? observation.content.at(-1)?.type
      : "",
    "image",
  );
  const persistedObservation = runtime.getSession(sessionId).messages.find(
    (message) => message.role === "user" && message.synthetic?.kind === "tool_observation",
  );
  assert.ok(persistedObservation);
});

class PromptCaptureProvider implements ModelProvider {
  request?: ProviderRequest;

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "prompt-capture" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.request = request;
    return { message: { role: "assistant", content: "done", toolCalls: [] } };
  }
}

test("agent defaults runtime automation off and gives the model an explicit per-turn policy", async () => {
  const provider = new PromptCaptureProvider();
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new ToolRegistry(await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-agent-automation-off-")))),
    model: "prompt-capture",
    emit: (event) => events.push(event),
  });
  const sessionId = runtime.createSession();
  await runtime.runTurn(sessionId, "inspect only");

  assert.match(provider.request?.systemPrompt ?? "", /Runtime game automation is disabled for this turn/);
  assert.match(provider.request?.systemPrompt ?? "", /Do not call game_test, game_automation_run, or game_automation_cancel/);
  assert.doesNotMatch(provider.request?.systemPrompt ?? "", /Runtime game automation is enabled for this turn/);
  const started = events.find((event) => event.type === "turn.started")?.data as {
    runtime_automation_enabled: boolean;
  };
  assert.equal(started.runtime_automation_enabled, false);
  assert.throws(
    () => runtime.validateTurn(sessionId, "bad", { runtimeAutomationEnabled: "yes" as unknown as boolean }),
    /must be a boolean/,
  );
});

test("agent injects selected SkillX instructions and only policy-allowed capability hints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-agent-skillx-"));
  const skillRegistry = new SkillRegistry({
    workspaceRoot: root,
    dataDirectory: path.join(root, "user-data"),
    builtinRoot: path.join(root, "builtin-skills"),
  });
  await skillRegistry.save({
    scope: "project",
    name: "movement-review",
    description: "Review player movement scripts",
    instructions: "Inspect movement definitions before proposing changes.",
    triggers: ["movement review"],
    capabilities: ["run_command", "unregistered_tool"],
    enabled: true,
  });
  const provider = new PromptCaptureProvider();
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new ToolRegistry(await Workspace.open(root)),
    skillRegistry,
    model: "prompt-capture",
    emit: (event) => events.push(event),
  });

  const sessionId = runtime.createSession();
  await runtime.runTurn(sessionId, "movement review");

  assert.match(provider.request?.systemPrompt ?? "", /Inspect movement definitions before proposing changes/u);
  assert.match(provider.request?.systemPrompt ?? "", /A Skill never expands filesystem, command, editor, or approval authority/u);
  assert.ok(provider.request?.tools.some((tool) => tool.name === "run_command"));
  assert.equal(provider.request?.tools.some((tool) => tool.name === "unregistered_tool"), false);
  const started = events.find((event) => event.type === "turn.started")?.data as {
    active_skills?: Array<{ id?: string; scope?: string }>;
  };
  assert.deepEqual(started.active_skills, [{
    id: "project:movement-review",
    name: "movement-review",
    description: "Review player movement scripts",
    scope: "project",
  }]);

  await runtime.runTurn(sessionId, "movement review; read only and do not run commands");
  assert.equal(provider.request?.tools.some((tool) => tool.name === "run_command"), false);
});

test("agent publishes web tools for a wrapped Chinese external search request", async () => {
  const provider = new PromptCaptureProvider();
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new ToolRegistry(await Workspace.open(await mkdtemp(path.join(tmpdir(), "godetx-agent-web-route-")))),
    model: "prompt-capture",
    emit: (event) => events.push(event),
  });
  const prompt = `<godot_editor_context>\ncurrent_scene: demo/main.tscn\ncurrent_script: demo/main.gd\n</godot_editor_context>\n\nUser request:\n搜索一下 Steam 前 10 的游戏`;

  await runtime.runTurn(runtime.createSession(), prompt);

  assert.deepEqual(provider.request?.tools.map((tool) => tool.name), [
    "web_search",
    "web_open",
    "list_files",
    "read_file",
    "search_text",
  ]);
  assert.match(provider.request?.systemPrompt ?? "", /selected the "web" tool profile/);
  const started = events.find((event) => event.type === "turn.started")?.data as {
    tool_profile?: string;
    tool_names?: string[];
  };
  assert.equal(started.tool_profile, "web");
  assert.ok(started.tool_names?.includes("web_search"));
});

class ReplayProvider implements ModelProvider {
  calls = 0;

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "scripted" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls <= 2) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "replayed_call",
              name: "apply_patch",
              arguments: JSON.stringify({
                operations: [{ action: "replace", path: "target.gd", old_text: "Before", new_text: "After" }],
              }),
            },
          ],
        },
      };
    }
    const result = request.messages.at(-1);
    assert.equal(result?.role, "tool");
    if (result?.role === "tool") assert.equal(JSON.parse(result.content).ok, true);
    return { message: { role: "assistant", content: "done", toolCalls: [] } };
  }
}

test("agent replays cached tool results without repeating side effects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-replay-"));
  await writeFile(path.join(root, "target.gd"), "Before\n");
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider: new ReplayProvider(),
    tools: new ToolRegistry(await Workspace.open(root)),
    model: "scripted",
    approvalMode: "auto",
    emit: (event) => events.push(event),
  });
  const sessionId = runtime.createSession();
  await runtime.runTurn(sessionId, "edit once");
  assert.equal(await readFile(path.join(root, "target.gd"), "utf8"), "After\n");
  assert.equal(events.filter((event) => event.type === "file_change.applied").length, 1);
  assert.ok(
    events.some(
      (event) => event.type === "tool.completed" && (event.data as { replayed?: boolean }).replayed === true,
    ),
  );
});

class RecordingToolKernel implements ToolKernel {
  readonly calls: ToolCall[] = [];

  constructor(readonly schemas: ToolSchema[]) {}

  definitions(): ToolSchema[] {
    return this.schemas;
  }

  async execute(call: ToolCall, _context: ToolContext): Promise<Record<string, unknown>> {
    this.calls.push(call);
    return { ok: true, tool: call.name };
  }
}

class LongProgressProvider implements ModelProvider {
  calls = 0;

  constructor(readonly toolSteps: number) {}

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "long-progress" }];
  }

  async streamTurn(): Promise<ProviderTurnResult> {
    this.calls += 1;
    if (this.calls <= this.toolSteps) {
      return toolCallResult(`long_${this.calls}`, "read_file", { path: `file-${this.calls}.gd` });
    }
    return { message: { role: "assistant", content: "large task complete", toolCalls: [] } };
  }
}

test("adaptive agent loop completes a progressing task beyond sixteen model steps", async () => {
  const provider = new LongProgressProvider(20);
  const tools = new RecordingToolKernel([testToolSchema("read_file")]);
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "long-progress",
    emit: (event) => events.push(event),
  });

  await runtime.runTurn(runtime.createSession(), "Read the project files needed for this large task");

  assert.equal(provider.calls, 21);
  assert.equal(tools.calls.length, 20);
  const started = events.find((event) => event.type === "turn.started")?.data as {
    loop_mode?: string;
    max_model_steps?: number;
  };
  assert.equal(started.loop_mode, "adaptive");
  assert.equal(started.max_model_steps, undefined);
  const completed = events.find((event) => event.type === "turn.completed")?.data as {
    model_steps?: number;
    tool_calls?: number;
    loop_mode?: string;
  };
  assert.equal(completed.model_steps, 21);
  assert.equal(completed.tool_calls, 20);
  assert.equal(completed.loop_mode, "adaptive");
});

test("explicit legacy maxSteps still applies as a compatibility limit", async () => {
  const provider = new LongProgressProvider(10);
  const tools = new RecordingToolKernel([testToolSchema("read_file")]);
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "legacy-fixed-loop",
    maxSteps: 3,
    emit: () => undefined,
  });

  await assert.rejects(
    runtime.runTurn(runtime.createSession(), "Read files for a legacy bounded task"),
    /configured maximum of 3 model steps/u,
  );
  assert.equal(provider.calls, 3);
  assert.equal(tools.calls.length, 3);
});

class RepeatedBatchProvider implements ModelProvider {
  calls = 0;

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "repeated-batch" }];
  }

  async streamTurn(): Promise<ProviderTurnResult> {
    this.calls += 1;
    return toolCallResult(`repeat_${this.calls}`, "read_file", { path: "same-file.gd" });
  }
}

class VolatileStatusToolKernel implements ToolKernel {
  calls = 0;

  definitions(): ToolSchema[] {
    return [testToolSchema("read_file")];
  }

  async execute(): Promise<Record<string, unknown>> {
    this.calls += 1;
    return { ok: true, state: "unchanged", duration_ms: this.calls * 10 };
  }
}

test("adaptive agent loop stops before a third unchanged tool batch execution", async () => {
  const provider = new RepeatedBatchProvider();
  const tools = new VolatileStatusToolKernel();
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "repeated-batch",
    emit: () => undefined,
  });

  await assert.rejects(
    runtime.runTurn(runtime.createSession(), "Keep reading the same project file"),
    /stopped before a third execution/u,
  );
  assert.equal(provider.calls, 3);
  assert.equal(tools.calls, 2);
});

class DistinctFailureProvider implements ModelProvider {
  calls = 0;
  readonly requests: ProviderRequest[] = [];

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "distinct-failures" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    this.requests.push(request);
    return toolCallResult(`failure_${this.calls}`, "read_file", { path: `missing-${this.calls}.gd` });
  }
}

class FailingToolKernel implements ToolKernel {
  calls = 0;

  definitions(): ToolSchema[] {
    return [testToolSchema("read_file")];
  }

  async execute(): Promise<Record<string, unknown>> {
    this.calls += 1;
    return { ok: false, error: "File is unavailable" };
  }
}

test("adaptive agent loop changes strategy prompt and stops distinct unsuccessful churn", async () => {
  const provider = new DistinctFailureProvider();
  const tools = new FailingToolKernel();
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "distinct-failures",
    emit: () => undefined,
  });

  await assert.rejects(
    runtime.runTurn(runtime.createSession(), "Inspect all relevant project files"),
    /no novel successful tool progress for 8 consecutive steps/u,
  );
  assert.equal(provider.calls, 8);
  assert.equal(tools.calls, 8);
  assert.match(provider.requests[4]?.systemPrompt ?? "", /last 4 model steps produced no new successful tool result/u);
});

class RouteFallbackProvider implements ModelProvider {
  calls = 0;
  readonly requests: ProviderRequest[] = [];

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "route-fallback" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["list_files", "read_file", "search_text"]);
      return toolCallResult("hidden-web", "web_search", { query: "Godot" });
    }
    if (this.calls === 2) {
      const routingResult = request.messages.at(-1);
      assert.equal(routingResult?.role, "tool");
      if (routingResult?.role === "tool") {
        assert.equal(JSON.parse(routingResult.content).code, "TOOL_ROUTE_EXPANDED");
      }
      assert.ok(request.tools.some((tool) => tool.name === "web_search"));
      assert.match(request.systemPrompt, /after a conservative routing fallback/);
      return toolCallResult("retry-web", "web_search", { query: "Godot" });
    }
    const toolResult = request.messages.at(-1);
    assert.equal(toolResult?.role, "tool");
    if (toolResult?.role === "tool") assert.equal(JSON.parse(toolResult.content).ok, true);
    return { message: { role: "assistant", content: "done", toolCalls: [] } };
  }
}

test("agent expands a misclassified route before executing an unadvertised tool", async () => {
  const tools = new RecordingToolKernel([
    testToolSchema("list_files"),
    testToolSchema("read_file"),
    testToolSchema("search_text"),
    testToolSchema("web_search"),
    testToolSchema("apply_patch"),
  ]);
  const provider = new RouteFallbackProvider();
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "route-fallback",
    approvalMode: "auto",
    emit: (event) => events.push(event),
  });

  await runtime.runTurn(runtime.createSession(), "Explain the project structure");

  assert.equal(provider.calls, 3);
  assert.deepEqual(tools.calls.map((call) => call.name), ["web_search"]);
  assert.ok(events.some((event) => (
    event.type === "tool.completed" &&
    (event.data as { routed?: boolean }).routed === false
  )));
});

class DisabledAutomationProvider implements ModelProvider {
  calls = 0;
  readonly requests: ProviderRequest[] = [];

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "disabled-automation" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) return toolCallResult("disabled-game-test", "game_test", {
      target: { mode: "main" },
      steps: [],
    });
    const result = request.messages.at(-1);
    assert.equal(result?.role, "tool");
    if (result?.role === "tool") assert.equal(JSON.parse(result.content).code, "TOOL_NOT_AVAILABLE");
    return { message: { role: "assistant", content: "automation is disabled", toolCalls: [] } };
  }
}

test("agent never expands or executes tools disabled by the turn policy", async () => {
  const tools = new RecordingToolKernel([
    testToolSchema("list_files"),
    testToolSchema("read_file"),
    testToolSchema("search_text"),
    testToolSchema("game_test"),
  ]);
  const provider = new DisabledAutomationProvider();
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "disabled-automation",
    approvalMode: "auto",
    emit: () => undefined,
  });

  await runtime.runTurn(runtime.createSession(), "Verify the current game locally", {
    runtimeAutomationEnabled: false,
  });

  assert.equal(tools.calls.length, 0);
  assert.equal(provider.requests.every((request) => (
    request.tools.every((tool) => tool.name !== "game_test")
  )), true);
});

class ReadOnlyViolationProvider implements ModelProvider {
  calls = 0;

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "read-only-violation" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.calls += 1;
    assert.equal(request.tools.some((tool) => tool.name === "apply_patch"), false);
    if (this.calls === 1) {
      return toolCallResult("blocked-write", "apply_patch", { operations: [] });
    }
    const result = request.messages.at(-1);
    assert.equal(result?.role, "tool");
    if (result?.role === "tool") assert.equal(JSON.parse(result.content).code, "TOOL_NOT_AVAILABLE");
    return { message: { role: "assistant", content: "read-only", toolCalls: [] } };
  }
}

test("auto approval cannot bypass an explicit read-only tool policy", async () => {
  const tools = new RecordingToolKernel([
    testToolSchema("list_files"),
    testToolSchema("read_file"),
    testToolSchema("search_text"),
    testToolSchema("apply_patch"),
  ]);
  const provider = new ReadOnlyViolationProvider();
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "read-only-violation",
    approvalMode: "auto",
    emit: () => undefined,
  });

  await runtime.runTurn(runtime.createSession(), "不要修改，只告诉我失败原因");

  assert.equal(provider.calls, 2);
  assert.equal(tools.calls.length, 0);
});

class PersistenceProvider implements ModelProvider {
  request?: ProviderRequest;

  constructor(readonly response: string, readonly emitDetails = false) {}

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "persistent" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.request = request;
    if (this.emitDetails) {
      request.onEvent({ type: "reasoning_delta", text: "检查持久化状态" });
      request.onEvent({
        type: "usage",
        usage: { inputTokens: 21, outputTokens: 4, totalTokens: 25 },
      });
    }
    return { message: { role: "assistant", content: this.response, toolCalls: [] } };
  }
}

test("agent restores a persisted provider-neutral session with display history and usage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-agent-session-"));
  const store = new SessionStore(directory);
  const firstProvider = new PersistenceProvider("第一轮完成", true);
  const firstRuntime = new AgentRuntime({
    provider: firstProvider,
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: () => undefined,
    sessionStore: store,
  });
  const sessionId = firstRuntime.createSession();
  const internalPrompt = "<godot_editor_context>hidden lease</godot_editor_context>\n检查当前场景";
  await firstRuntime.runTurn(sessionId, internalPrompt, { displayPrompt: "检查当前场景" });

  const firstSnapshot = firstRuntime.getSession(sessionId);
  assert.equal(firstSnapshot.title, "检查当前场景");
  assert.equal(firstSnapshot.turns[0]?.prompt, "检查当前场景");
  assert.equal(firstSnapshot.turns[0]?.entries[0]?.kind, "assistant");
  assert.equal(
    firstSnapshot.turns[0]?.entries[0]?.kind === "assistant"
      ? firstSnapshot.turns[0].entries[0].reasoning
      : "",
    "检查持久化状态",
  );
  assert.deepEqual(firstSnapshot.turns[0]?.usage, { inputTokens: 21, outputTokens: 4, totalTokens: 25 });
  assert.ok((firstSnapshot.turns[0]?.context?.contextCharacters ?? 0) > 0);
  assert.ok((firstSnapshot.turns[0]?.context?.historyCharacters ?? 0) > 0);
  firstRuntime.dispose();

  const secondProvider = new PersistenceProvider("第二轮完成");
  const secondRuntime = new AgentRuntime({
    provider: secondProvider,
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: () => undefined,
    sessionStore: new SessionStore(directory),
  });
  assert.equal(secondRuntime.listSessions()[0]?.id, sessionId);
  await secondRuntime.runTurn(sessionId, "继续内部任务", { displayPrompt: "继续" });

  assert.deepEqual(secondProvider.request?.messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
  ]);
  const restoredUser = secondProvider.request?.messages[0];
  assert.equal(restoredUser?.role === "user" ? restoredUser.content : "", internalPrompt);
  assert.equal(secondRuntime.getSession(sessionId).turns.length, 2);
});

test("agent rejects stale session mutations across runtime connections", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-agent-conflict-"));
  const creator = new AgentRuntime({
    provider: new PersistenceProvider("created"),
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: () => undefined,
    sessionStore: new SessionStore(directory),
  });
  const sessionId = creator.createSession();
  creator.dispose();

  const left = new AgentRuntime({
    provider: new PersistenceProvider("left"),
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: () => undefined,
    sessionStore: new SessionStore(directory),
  });
  const staleProvider = new PersistenceProvider("must not run");
  const stale = new AgentRuntime({
    provider: staleProvider,
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: () => undefined,
    sessionStore: new SessionStore(directory),
  });

  left.renameSession(sessionId, "Fresh title");
  assert.equal(stale.getSession(sessionId).title, "Fresh title", "Opening a stale session should reload it");
  stale.renameSession(sessionId, "Second title");
  assert.equal(left.getSession(sessionId).title, "Second title");
  assert.equal(left.deleteSession(sessionId), true);
  await assert.rejects(stale.runTurn(sessionId, "resurrect"), /Unknown session/u);
  assert.equal(staleProvider.request, undefined, "A stale turn must fail before contacting the provider");
  assert.equal(new SessionStore(directory).loadAll().length, 0);
});

test("agent fails an oversized current instruction before contacting the provider and persists the reason", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-agent-context-limit-"));
  const provider = new PersistenceProvider("must not run");
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new RecordingToolKernel([]),
    model: "persistent",
    emit: (event) => events.push(event),
    sessionStore: new SessionStore(directory),
    maxContextCharacters: 16_000,
  });
  const sessionId = runtime.createSession();
  await assert.rejects(
    runtime.runTurn(sessionId, "x".repeat(20_000)),
    /Current user request exceeds the safe context budget/u,
  );
  assert.equal(provider.request, undefined);
  const failed = runtime.getSession(sessionId).turns[0];
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /Current user request exceeds the safe context budget/u);
  assert.ok(events.some((event) => event.type === "turn.failed"));
});

test("agent emits and persists a safe structured billing failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-agent-billing-"));
  const workspaceId = "wrk_01KVZ8SWFCWGSBX6RA1WCQ6K24";
  const billingUrl = `https://opencode.ai/workspace/${workspaceId}/billing`;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "credit-exhausted-key",
    mode: "responses",
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
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: new RecordingToolKernel([]),
    model: "gpt-5.6-sol",
    emit: (event) => events.push(event),
    sessionStore: new SessionStore(directory),
  });
  const sessionId = runtime.createSession();

  await assert.rejects(runtime.runTurn(sessionId, "HI"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/iu);
    assert.doesNotMatch(error.message, /https?:\/\//u);
    assert.doesNotMatch(error.message, new RegExp(workspaceId, "u"));
    return true;
  });

  const failure = events.find((event) => event.type === "turn.failed");
  assert.ok(failure);
  const failureData = failure.data as {
    status?: string;
    error?: string;
    code?: string;
    data?: unknown;
  };
  assert.equal(failureData.status, "failed");
  assert.equal(failureData.code, "PROVIDER_BILLING_FAILED");
  assert.deepEqual(failureData.data, { status: 401 });
  assert.match(failureData.error ?? "", /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/iu);
  assert.doesNotMatch(failureData.error ?? "", /https?:\/\//u);
  assert.doesNotMatch(failureData.error ?? "", new RegExp(workspaceId, "u"));

  const persisted = new SessionStore(directory).loadAll().find((session) => session.id === sessionId);
  assert.ok(persisted);
  assert.equal(persisted.turns[0]?.status, "failed");
  assert.equal(persisted.turns[0]?.errorCode, "PROVIDER_BILLING_FAILED");
  assert.equal(persisted.turns[0]?.errorStatus, 401);
  assert.match(persisted.turns[0]?.error ?? "", /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/iu);
  assert.doesNotMatch(JSON.stringify(persisted), /https?:\/\//u);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(workspaceId, "u"));
});

test("agent rejects oversized provider tool-call batches before any tool executes", async () => {
  const provider: ModelProvider = {
    async listModels() {
      return [{ id: "tool-batch" }];
    },
    async streamTurn() {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: Array.from({ length: 65 }, (_, index) => ({
            id: `call_${index}`,
            name: "read_file",
            arguments: "{}",
          })),
        },
      };
    },
  };
  const tools = new RecordingToolKernel([testToolSchema("read_file")]);
  const runtime = new AgentRuntime({
    provider,
    tools,
    model: "tool-batch",
    emit: () => undefined,
  });
  const sessionId = runtime.createSession();
  await assert.rejects(
    runtime.runTurn(sessionId, "read the project"),
    /more than 64 tool calls/u,
  );
  assert.equal(tools.calls.length, 0);
});

function testToolSchema(name: string): ToolSchema {
  return { name, description: `${name} test schema`, parameters: { type: "object" } };
}

function toolCallResult(id: string, name: string, args: Record<string, unknown>): ProviderTurnResult {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    },
  };
}

function makeAgentTestPngHeader(width: number, height: number): Buffer {
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
