import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/workspace.js";

test("workspace previews and applies an exact patch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-workspace-"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "target.gd"), 'const GREETING = "Before"\n');
  const workspace = await Workspace.open(root, ["scripts/target.gd"]);
  const transaction = await workspace.preparePatch([
    {
      action: "replace",
      path: "scripts/target.gd",
      old_text: '"Before"',
      new_text: '"After"',
    },
  ]);
  assert.match(transaction.diff, /Before/);
  assert.match(transaction.diff, /After/);
  assert.deepEqual(await workspace.apply(transaction), ["scripts/target.gd"]);
  assert.equal(await readFile(path.join(root, "scripts", "target.gd"), "utf8"), 'const GREETING = "After"\n');
});

test("workspace rejects stale, escaped, protected, and non-allowlisted changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-safety-"));
  await writeFile(path.join(root, "target.gd"), "old\n");
  const workspace = await Workspace.open(root, ["target.gd"]);
  const transaction = await workspace.preparePatch([
    { action: "replace", path: "target.gd", old_text: "old", new_text: "new" },
  ]);
  await writeFile(path.join(root, "target.gd"), "changed externally\n");
  await assert.rejects(workspace.apply(transaction), /stale patch/);
  await assert.rejects(
    workspace.preparePatch([{ action: "create", path: "../escape.txt", content: "no" }]),
    /escapes workspace/,
  );
  await assert.rejects(
    workspace.preparePatch([{ action: "create", path: ".godot/cache", content: "no" }]),
    /Protected path/,
  );
  await assert.rejects(
    workspace.preparePatch([{ action: "create", path: "other.txt", content: "no" }]),
    /allowlist/,
  );
});

test("workspace requires unique old text by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-unique-"));
  await writeFile(path.join(root, "target.txt"), "same same");
  const workspace = await Workspace.open(root);
  await assert.rejects(
    workspace.preparePatch([
      { action: "replace", path: "target.txt", old_text: "same", new_text: "next" },
    ]),
    /occurs 2 times/,
  );
});

test("workspace writes binary artifacts once without crossing safety boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-binary-"));
  const workspace = await Workspace.open(root);
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(await workspace.writeBinary("assets/generated/test.png", bytes), "assets/generated/test.png");
  assert.deepEqual([...await readFile(path.join(root, "assets", "generated", "test.png"))], [...bytes]);
  await assert.rejects(
    workspace.writeBinary("assets/generated/test.png", bytes),
    /EEXIST/,
  );
  await assert.rejects(workspace.writeBinary("../outside.png", bytes), /escapes workspace/);
  await assert.rejects(workspace.writeBinary(".godetx/private.png", bytes), /Protected path/);
  await assert.rejects(workspace.writeBinary("assets/generated/empty.png", new Uint8Array()), /must not be empty/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    workspace.writeBinary("assets/generated/cancelled.png", bytes, controller.signal),
    /aborted/iu,
  );
  await assert.rejects(readFile(path.join(root, "assets", "generated", "cancelled.png")), /ENOENT/u);
});

test("workspace supports multiple exact edits in one file as one transaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-multi-edit-"));
  await writeFile(path.join(root, "target.txt"), "first\nmiddle\nlast\n");
  const workspace = await Workspace.open(root);
  const transaction = await workspace.preparePatch([
    { action: "replace", path: "target.txt", old_text: "first", new_text: "one" },
    { action: "replace", path: "target.txt", old_text: "last", new_text: "three" },
  ]);
  assert.equal(transaction.changes.length, 1);
  await workspace.apply(transaction);
  assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "one\nmiddle\nthree\n");
});

test("workspace blocks protected paths case-insensitively and never exposes secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-secrets-"));
  await mkdir(path.join(root, ".GIT"));
  await writeFile(path.join(root, ".GIT", "config"), "secret git data");
  await writeFile(path.join(root, ".env"), "TOKEN=secret");
  await writeFile(path.join(root, ".ENV.Development"), "TOKEN=another-secret");
  await writeFile(path.join(root, "safe.txt"), "safe");
  const workspace = await Workspace.open(root);
  assert.deepEqual(await workspace.listFiles(), ["safe.txt"]);
  await assert.rejects(workspace.readText(".env"), /Protected path cannot be read/);
  await assert.rejects(workspace.readText(".ENV.Development"), /Protected path cannot be read/);
  await assert.rejects(workspace.readText(".GIT/config"), /Protected path cannot be read/);
  await assert.rejects(
    workspace.preparePatch([{ action: "replace", path: ".GIT/config", old_text: "secret", new_text: "changed" }]),
    /Protected path cannot be modified/,
  );
});

test("workspace discovers Godot scenes without temporary trees consuming the result limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-discovery-"));
  await mkdir(path.join(root, ".tmp", "imagegen-deps"), { recursive: true });
  await mkdir(path.join(root, "aaa-assets"));
  await mkdir(path.join(root, "scenes"));
  await writeFile(path.join(root, "project.godot"), "config_version=5\n");
  await writeFile(path.join(root, ".tmp", "imagegen-deps", "hidden.tscn"), '[node name="Title"]\n');
  for (let index = 0; index < 20; index += 1) {
    await writeFile(path.join(root, "aaa-assets", `asset-${index}.txt`), "generated\n");
  }
  await writeFile(path.join(root, "scenes", "current.tscn"), '[node name="Title" type="Label"]\n');

  const workspace = await Workspace.open(root);
  assert.ok((await workspace.listFiles(2)).includes("project.godot"));
  assert.deepEqual(await workspace.listFiles(10, ".tscn"), ["scenes/current.tscn"]);
  assert.deepEqual(await workspace.search("Title", ".tscn", 10), [
    { path: "scenes/current.tscn", line: 1, text: '[node name="Title" type="Label"]' },
  ]);
  await assert.rejects(workspace.readText(".tmp/imagegen-deps/hidden.tscn"), /Protected path/);
});
