import assert from "node:assert/strict";
import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { EventFactory, type RuntimeEvent } from "../src/protocol.js";
import { ToolRegistry, type ToolContext } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

test("run_command rejects Godot executables before requesting approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-tools-"));
  const registry = new ToolRegistry(await Workspace.open(root));

  const blockedCommands = [
    { executable: "godot", error: /Launching another Godot process is disabled/ },
    { executable: "GODOT.EXE", error: /Launching another Godot process is disabled/ },
    { executable: "godot4", error: /Launching another Godot process is disabled/ },
    { executable: "Godot4.exe", error: /Launching another Godot process is disabled/ },
    { executable: "C:\\Godot\\godot.exe", error: /Executable is not allowed/ },
    { executable: "/usr/bin/godot", error: /Executable is not allowed/ },
    { executable: "godot.windows.opt.tools.64.exe", error: /Executable is not allowed/ },
  ];

  for (const { executable, error } of blockedCommands) {
    const emitted: RuntimeEvent[] = [];
    const events = new EventFactory();
    const context: ToolContext = {
      sessionId: "session",
      turnId: "turn",
      itemId: `item-${executable}`,
      runtimeAutomationEnabled: false,
      approvalMode: "ask",
      signal: new AbortController().signal,
      approvals: new ApprovalManager(),
      emit: (type, data, itemId) => {
        const event = events.create(type, data, {
          sessionId: "session",
          turnId: "turn",
          ...(itemId ? { itemId } : {}),
        });
        emitted.push(event);
        return event;
      },
    };

    await assert.rejects(
      registry.execute(
        {
          id: `call-${executable}`,
          name: "run_command",
          arguments: JSON.stringify({ command: [executable, "--headless", "--editor"] }),
        },
        context,
      ),
      error,
    );
    assert.equal(emitted.some((event) => event.type === "approval.requested"), false);
  }
});

test("run_command safely redirects strict single-file read commands to read_file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-command-read-"));
  await writeFile(path.join(root, "main.gd"), 'extends Node\nconst MESSAGE = "hello"\n');
  const registry = new ToolRegistry(await Workspace.open(root));
  const emitted: RuntimeEvent[] = [];
  const events = new EventFactory();
  const context: ToolContext = {
    sessionId: "session-command-read",
    turnId: "turn-command-read",
    itemId: "item-command-read",
    runtimeAutomationEnabled: false,
    approvalMode: "ask",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => {
      const event = events.create(type, data, {
        sessionId: "session-command-read",
        turnId: "turn-command-read",
        ...(itemId ? { itemId } : {}),
      });
      emitted.push(event);
      return event;
    },
  };
  const content = 'extends Node\nconst MESSAGE = "hello"\n';
  const commands = [
    ["cat", "main.gd"],
    ["type", "res://main.gd"],
    ["Get-Content", "main.gd"],
  ];

  for (const [index, command] of commands.entries()) {
    const result = await registry.execute(
      {
        id: `compatibility-read-${index}`,
        name: "run_command",
        arguments: JSON.stringify({ command }),
      },
      context,
    );

    assert.deepEqual(result, {
      ok: true,
      path: "main.gd",
      content,
      handled_by: "read_file",
    });
  }

  assert.equal(emitted.some((event) => event.type === "approval.requested"), false);
  assert.equal(emitted.some((event) => event.type === "approval.resolved"), false);
  assert.equal(emitted.some((event) => event.type === "tool.output.delta"), false);
});

test("run_command read compatibility cannot bypass command or workspace boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-command-read-boundaries-"));
  await writeFile(path.join(root, "main.gd"), "extends Node\n");
  await writeFile(path.join(root, ".env"), "SECRET=protected\n");
  const registry = new ToolRegistry(await Workspace.open(root));
  const emitted: RuntimeEvent[] = [];
  const events = new EventFactory();
  const context: ToolContext = {
    sessionId: "session-command-read-boundaries",
    turnId: "turn-command-read-boundaries",
    itemId: "item-command-read-boundaries",
    runtimeAutomationEnabled: false,
    approvalMode: "ask",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => {
      const event = events.create(type, data, {
        sessionId: "session-command-read-boundaries",
        turnId: "turn-command-read-boundaries",
        ...(itemId ? { itemId } : {}),
      });
      emitted.push(event);
      return event;
    },
  };

  await assert.rejects(
    registry.execute(
      {
        id: "protected-read",
        name: "run_command",
        arguments: JSON.stringify({ command: ["cat", ".env"] }),
      },
      context,
    ),
    /Protected path cannot be read/,
  );
  await assert.rejects(
    registry.execute(
      {
        id: "escaping-read",
        name: "run_command",
        arguments: JSON.stringify({ command: ["type", "res://../outside.gd"] }),
      },
      context,
    ),
    /Path escapes workspace/,
  );

  const nonStrictCommands = [
    ["cat", "main.gd", "another.gd"],
    ["cat", "-n"],
    ["Get-Content", "-Path", "main.gd"],
    ["type", "--", "main.gd"],
  ];
  for (const [index, command] of nonStrictCommands.entries()) {
    await assert.rejects(
      registry.execute(
        {
          id: `non-strict-read-${index}`,
          name: "run_command",
          arguments: JSON.stringify({ command }),
        },
        context,
      ),
      /use read_file/,
    );
  }

  await assert.rejects(
    registry.execute(
      {
        id: "unknown-command-field",
        name: "run_command",
        arguments: JSON.stringify({ command: ["cat", "main.gd"], shell: true }),
      },
      context,
    ),
    /Unsupported tool argument: shell/,
  );

  assert.equal(emitted.some((event) => event.type === "approval.requested"), false);
  assert.equal(emitted.some((event) => event.type === "tool.output.delta"), false);
});

test("run_command schema tells the model that Godot is hosted by the editor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-tools-schema-"));
  const registry = new ToolRegistry(await Workspace.open(root));
  const runCommand = registry.definitions().find((tool) => tool.name === "run_command");

  assert.match(runCommand?.description ?? "", /Godot is already running as the host editor/);
  assert.match(runCommand?.description ?? "", /headless editor/);
  assert.match(runCommand?.description ?? "", /Do not use it to read, list, or search project files/);
  assert.match(runCommand?.description ?? "", /read_file, list_files, or search_text/);
  assert.match(runCommand?.description ?? "", /cat, type, Get-Content, ls, dir, grep, find, and rg/);

  const listFiles = registry.definitions().find((tool) => tool.name === "list_files");
  assert.match(listFiles?.description ?? "", /file_suffix/);
  assert.ok(
    (listFiles?.parameters.properties as Record<string, unknown> | undefined)?.file_suffix,
    "list_files should expose file_suffix",
  );
});

test("godot_scene schema exposes only values supported by its codec", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-scene-schema-"));
  const registry = new ToolRegistry(await Workspace.open(root));
  const sceneTool = registry.definitions().find((tool) => tool.name === "godot_scene");
  const serialized = JSON.stringify(sceneTool?.parameters ?? {});

  assert.match(sceneTool?.description ?? "", /must be flat/);
  assert.match(sceneTool?.description ?? "", /theme_override_font_sizes\/font_size/);
  assert.match(serialized, /Vector2i/);
  assert.match(serialized, /Vector3/);
  assert.match(serialized, /Color/);
  assert.match(serialized, /"maxItems":64/);
  assert.doesNotMatch(serialized, /"value":\{\}/);
  assert.doesNotMatch(serialized, /int64/);
  assert.doesNotMatch(serialized, /Vector4/);
});

test("godot_scene rejects malformed operations before reading a scene", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-scene-args-"));
  const registry = new ToolRegistry(await Workspace.open(root));
  const context: ToolContext = {
    sessionId: "session",
    turnId: "turn",
    itemId: "item",
    runtimeAutomationEnabled: false,
    approvalMode: "auto",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => new EventFactory().create(type, data, { ...(itemId ? { itemId } : {}) }),
  };

  await assert.rejects(
    registry.execute(
      {
        id: "bad-scene-call",
        name: "godot_scene",
        arguments: JSON.stringify({
          scene_path: "missing.tscn",
          operations: [{ action: "set_property", node_path: ".", property: "text", value: "x", extra: true }],
        }),
      },
      context,
    ),
    /contains unsupported field: extra/,
  );
});

test("godot_scene recovers the nested theme override shape from the failed UI task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-scene-recovery-"));
  const scenePath = path.join(root, "main.tscn");
  await writeFile(scenePath, '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n');
  const registry = new ToolRegistry(await Workspace.open(root));
  const events = new EventFactory();
  const context: ToolContext = {
    sessionId: "session",
    turnId: "turn",
    itemId: "item",
    runtimeAutomationEnabled: false,
    approvalMode: "auto",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => events.create(type, data, { ...(itemId ? { itemId } : {}) }),
  };
  const result = await registry.execute(
    {
      id: "scene-recovery",
      name: "godot_scene",
      arguments: JSON.stringify({
        scene_path: "main.tscn",
        operations: [
          {
            action: "add_node",
            name: "Description",
            node_type: "Label",
            parent: ".",
            properties: {
              text: "Hello",
              theme_override_font_sizes: { font_size: 18 },
              theme_override_colors: {
                font_color: { godot_type: "Color", r: 0.8, g: 0.9, b: 1, a: 1 },
              },
            },
          },
        ],
      }),
    },
    context,
  );

  assert.equal(result.ok, true);
  const scene = await readFile(scenePath, "utf8");
  assert.match(scene, /theme_override_font_sizes\/font_size = 18/);
  assert.match(scene, /theme_override_colors\/font_color = Color\(0\.8, 0\.9, 1, 1\)/);
});

test("file tools reject every editor-open scene path while allowing closed scenes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-open-scenes-"));
  const initialScene = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
  await writeFile(path.join(root, "leased.tscn"), initialScene);
  await link(path.join(root, "leased.tscn"), path.join(root, "leased-alias.tscn"));
  await writeFile(path.join(root, "open-unleased.tscn"), initialScene);
  await writeFile(path.join(root, "closed.tscn"), initialScene);
  const registry = new ToolRegistry(await Workspace.open(root));
  const events: RuntimeEvent[] = [];
  const factory = new EventFactory();
  const context: ToolContext = {
    sessionId: "session-open-scenes",
    turnId: "turn-open-scenes",
    itemId: "item-open-scenes",
    sceneLeases: [{
      scene_id: "scene-leased",
      scene_path: "res://leased.tscn",
      scene_revision: "revision-1",
    }],
    primarySceneId: "scene-leased",
    openScenePaths: ["res://leased.tscn", "res://open-unleased.tscn"],
    runtimeAutomationEnabled: false,
    approvalMode: "auto",
    signal: new AbortController().signal,
    approvals: new ApprovalManager(),
    emit: (type, data, itemId) => {
      const event = factory.create(type, data, { ...(itemId ? { itemId } : {}) });
      events.push(event);
      return event;
    },
  };

  for (const scenePath of ["leased.tscn", "leased-alias.tscn", "open-unleased.tscn"]) {
    await assert.rejects(
      registry.execute(
        {
          id: `patch-${scenePath}`,
          name: "apply_patch",
          arguments: JSON.stringify({
            operations: [{
              action: "replace",
              path: scenePath,
              old_text: 'name="Main"',
              new_text: 'name="Changed"',
            }],
          }),
        },
        context,
      ),
      /Open editor scene must be modified with scene_apply_operations/,
    );
    await assert.rejects(
      registry.execute(
        {
          id: `godot-scene-${scenePath}`,
          name: "godot_scene",
          arguments: JSON.stringify({
            scene_path: scenePath,
            operations: [{ action: "set_property", node_path: ".", property: "visible", value: false }],
          }),
        },
        context,
      ),
      /Open editor scene must be modified with scene_apply_operations/,
    );
  }

  assert.deepEqual(events, []);
  assert.equal(await readFile(path.join(root, "leased.tscn"), "utf8"), initialScene);
  assert.equal(await readFile(path.join(root, "open-unleased.tscn"), "utf8"), initialScene);

  const closedResult = await registry.execute(
    {
      id: "closed-scene",
      name: "godot_scene",
      arguments: JSON.stringify({
        scene_path: "closed.tscn",
        operations: [{ action: "set_property", node_path: ".", property: "visible", value: false }],
      }),
    },
    context,
  );
  assert.equal(closedResult.ok, true);
  assert.match(await readFile(path.join(root, "closed.tscn"), "utf8"), /visible = false/);
});
