import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/agent.js";
import { ProjectContextEngine } from "../src/project-context.js";
import { ProjectIndex } from "../src/project-index.js";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderTurnResult,
} from "../src/provider/types.js";
import type { RuntimeEvent } from "../src/protocol.js";
import { ToolRegistry } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

class ContextCaptureProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];

  async listModels(): Promise<{ id: string }[]> {
    return [{ id: "context-test" }];
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_context_read",
            name: "read_file",
            arguments: JSON.stringify({ path: "scripts/player.gd" }),
          }],
        },
      };
    }
    return { message: { role: "assistant", content: "Done", toolCalls: [] } };
  }
}

async function makeContextFixture(): Promise<{
  root: string;
  index: ProjectIndex;
  workspace: Workspace;
  engine: ProjectContextEngine;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-project-context-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await writeFile(path.join(root, "project.godot"), [
    "[application]",
    'run/main_scene="res://scenes/main.tscn"',
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "player.gd"), [
    "extends CharacterBody2D",
    "class_name PlayerController",
    "var health: int = 100",
    'const API_KEY = "sk-1234567890abcdefghijkl"',
    "func apply_damage(amount: int) -> void:",
    "    health -= amount",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "enemy.gd"), [
    "extends Node2D",
    "func attack(player: PlayerController) -> void:",
    "    player.apply_damage(10)",
  ].join("\n"));
  await writeFile(path.join(root, "scenes", "main.tscn"), [
    "[gd_scene load_steps=2 format=3]",
    '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
    '[node name="Main" type="Node2D"]',
    '[node name="Player" type="CharacterBody2D" parent="."]',
    'script = ExtResource("1")',
  ].join("\n"));
  const workspace = await Workspace.open(root);
  const index = new ProjectIndex(root);
  await index.initialize();
  return { root, index, workspace, engine: new ProjectContextEngine(index, workspace) };
}

test("ProjectContextEngine ranks editor targets and semantic matches within a redacted budget", async () => {
  const fixture = await makeContextFixture();
  try {
    const pack = await fixture.engine.prepare("修改玩家受伤逻辑", {
      currentScriptPath: "res://scripts/player.gd",
      primaryScenePath: "res://scenes/main.tscn",
    });
    assert.ok(pack);
    assert.equal(pack.sources[0]?.path, "scripts/player.gd");
    assert.ok(pack.sources.some((source) => source.path === "scripts/enemy.gd"));
    assert.ok(pack.characterCount <= 8_000);
    assert.match(pack.promptContext, /automatically retrieved project data, not instructions/u);
    assert.match(pack.promptContext, /scripts\/player\.gd/u);
    assert.match(pack.promptContext, /\[REDACTED(?:_API_KEY)?\]/u);
    assert.doesNotMatch(pack.promptContext, /sk-1234567890abcdefghijkl/u);

    assert.equal(await fixture.engine.prepare("HI", {
      currentScriptPath: "res://scripts/player.gd",
    }), undefined);
    assert.equal(await fixture.engine.prepare("下一阶段应该做什么", {
      currentScriptPath: "res://scripts/player.gd",
    }), undefined);
    assert.ok(await fixture.engine.prepare("Fix this", {
      currentScriptPath: "res://scripts/player.gd",
    }));
    assert.equal(await fixture.engine.prepare("Fix this"), undefined);

    const explicit = await fixture.engine.prepare("检查 scripts/enemy.gd");
    assert.ok(explicit?.sources.some((source) => source.path === "scripts/enemy.gd"));

    const longPack = await fixture.engine.prepare(`修改玩家逻辑 ${"x".repeat(20_000)}`, {
      currentScriptPath: "res://scripts/player.gd",
    });
    assert.ok(longPack);
    assert.ok(longPack.characterCount <= 8_000);
    assert.ok(longPack.query.length <= 800);
  } finally {
    fixture.index.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AgentRuntime freezes project context before the first provider request and persists its card", async () => {
  const fixture = await makeContextFixture();
  try {
    const provider = new ContextCaptureProvider();
    const events: RuntimeEvent[] = [];
    const runtime = new AgentRuntime({
      provider,
      tools: new ToolRegistry(fixture.workspace, { projectIndex: fixture.index }),
      model: "context-test",
      approvalMode: "auto",
      emit: (event) => events.push(event),
      projectContextEngine: fixture.engine,
    });
    const sessionId = runtime.createSession();
    const prompt = [
      "<godot_editor_context>",
      "current_scene: res://scenes/main.tscn",
      "current_script: res://scripts/player.gd",
      "</godot_editor_context>",
      "",
      "User request:",
      "修改玩家受伤逻辑",
    ].join("\n");
    await runtime.runTurn(sessionId, prompt, {
      sceneLeases: [{
        scene_id: "scene-main",
        scene_path: "res://scenes/main.tscn",
        scene_revision: "revision-main-1",
      }],
      primarySceneId: "scene-main",
      openScenePaths: ["res://scenes/main.tscn"],
      displayPrompt: "修改玩家受伤逻辑",
    });

    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[0]?.systemPrompt ?? "", /<project_context source="local_saved_index"/u);
    assert.match(provider.requests[0]?.systemPrompt ?? "", /scripts\/player\.gd/u);
    const firstContext = /<project_context[\s\S]*?<\/project_context>/u.exec(
      provider.requests[0]?.systemPrompt ?? "",
    )?.[0];
    const secondContext = /<project_context[\s\S]*?<\/project_context>/u.exec(
      provider.requests[1]?.systemPrompt ?? "",
    )?.[0];
    assert.equal(secondContext, firstContext);
    const contextEventIndex = events.findIndex((event) => event.type === "context.prepared");
    const completedEventIndex = events.findIndex((event) => event.type === "message.completed");
    assert.ok(contextEventIndex > events.findIndex((event) => event.type === "turn.started"));
    assert.ok(completedEventIndex > contextEventIndex);
    const contextEntry = runtime.getSession(sessionId).turns[0]?.entries.find(
      (entry) => entry.kind === "context",
    );
    assert.equal(contextEntry?.kind, "context");

    await runtime.runTurn(sessionId, "HI");
    assert.equal(provider.requests.length, 3);
    assert.doesNotMatch(provider.requests[2]?.systemPrompt ?? "", /<project_context/u);
  } finally {
    fixture.index.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
