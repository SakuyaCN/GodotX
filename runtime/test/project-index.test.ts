import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/project-index.js";

test("ProjectIndex finds Godot symbols, references, and resource dependencies", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "godetx-index-"));
  const index = new ProjectIndex(workspace);
  try {
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    await mkdir(path.join(workspace, "scenes"), { recursive: true });
    await mkdir(path.join(workspace, "resources"), { recursive: true });
    await writeFile(path.join(workspace, "project.godot"), [
      "[application]",
      'run/main_scene="res://scenes/main.tscn"',
      "[autoload]",
      'GameState="*res://scripts/player.gd"',
      "[input]",
      "jump={",
      "}",
    ].join("\n"));
    await writeFile(path.join(workspace, "scripts", "player.gd"), [
      "extends Node2D",
      "class_name PlayerController",
      "signal health_changed(value)",
      "@export var health: int = 10",
      "const MAX_HEALTH := 10",
      "func damage(amount: int) -> void:",
      "    health -= amount",
      "    health_changed.emit(health)",
    ].join("\n"));
    await writeFile(path.join(workspace, "resources", "player.tres"), [
      '[gd_resource type="Resource" load_steps=2 format=3]',
      '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
      "script = ExtResource(\"1\")",
    ].join("\n"));
    await writeFile(path.join(workspace, "scenes", "main.tscn"), [
      "[gd_scene load_steps=3 format=3]",
      '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
      '[ext_resource type="Resource" path="res://resources/player.tres" id="2"]',
      '[node name="Main" type="Node2D"]',
      '[node name="Player" type="Node2D" parent="."]',
      "script = ExtResource(\"1\")",
    ].join("\n"));

    const status = await index.initialize();
    assert.equal(status.state, "ready");
    assert.equal(status.fileCount, 4);
    assert.equal(status.truncated, false);

    const classes = await index.searchSymbols("PlayerController");
    assert.equal(classes[0]?.kind, "class");
    assert.equal(classes[0]?.path, "scripts/player.gd");
    assert.equal(classes[0]?.detail, "extends Node2D");

    const nodes = await index.searchSymbols("Player", { kinds: ["scene_node"] });
    assert.equal(nodes[0]?.name, "Player");
    const rootNodes = await index.searchSymbols("Main", { kinds: ["scene_node"] });
    assert.equal(rootNodes[0]?.name, ".");

    const references = await index.findReferences("health");
    assert.ok(references.length >= 3);
    assert.ok(references.some((reference) => reference.definition === true));

    const dependencies = await index.dependencyGraph("res://scenes/main.tscn", {
      direction: "dependencies",
      depth: 2,
    });
    assert.ok(dependencies.nodes.some((node) => node.path === "scripts/player.gd"));
    assert.ok(dependencies.nodes.some((node) => node.path === "resources/player.tres"));

    const dependents = await index.dependencyGraph("scripts/player.gd", {
      direction: "dependents",
      depth: 2,
    });
    assert.ok(dependents.nodes.some((node) => node.path === "scenes/main.tscn"));
    assert.ok(dependents.nodes.some((node) => node.path === "resources/player.tres"));

    const cache = JSON.parse(await readFile(index.cachePath, "utf8")) as { version?: unknown };
    assert.equal(cache.version, 1);
  } finally {
    index.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIndex incrementally replaces changed symbols", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "godetx-index-refresh-"));
  const index = new ProjectIndex(workspace);
  try {
    await writeFile(path.join(workspace, "actor.gd"), "class_name OldActor\nfunc old_method():\n    pass\n");
    await index.initialize();
    assert.equal((await index.searchSymbols("OldActor"))[0]?.name, "OldActor");

    await writeFile(path.join(workspace, "actor.gd"), "class_name NewActor\nfunc new_method():\n    pass\n# changed size\n");
    index.markDirty();
    await index.refresh();
    assert.equal((await index.searchSymbols("OldActor")).length, 0);
    assert.equal((await index.searchSymbols("NewActor"))[0]?.name, "NewActor");
  } finally {
    index.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIndex ignores malformed persisted entries and rebuilds from source", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "godetx-index-cache-"));
  const index = new ProjectIndex(workspace);
  try {
    await mkdir(path.dirname(index.cachePath), { recursive: true });
    await writeFile(index.cachePath, JSON.stringify({
      version: 1,
      lastIndexedAt: new Date().toISOString(),
      files: [{
        path: "outside.gd",
        size: 1,
        mtimeMs: 1,
        kind: "gdscript",
        symbols: [{ name: 42 }],
        references: [{}],
        dependencies: ["../outside.gd"],
      }],
    }));
    await writeFile(path.join(workspace, "valid.gd"), "extends Node\nclass_name ValidCachedClass\n");

    const status = await index.initialize();
    assert.equal(status.state, "ready");
    assert.equal(status.truncated, false);
    assert.equal((await index.searchSymbols("ValidCachedClass"))[0]?.path, "valid.gd");
    assert.equal((await index.searchSymbols("outside")).length, 0);
  } finally {
    index.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});
