import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSkill, SkillRegistry } from "../src/skills.js";

function skillSource(name: string, description: string, trigger: string, instruction: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "enabled: true",
    "triggers:",
    `  - ${JSON.stringify(trigger)}`,
    "capabilities:",
    '  - "project_symbol_search"',
    '  - "apply_patch"',
    "---",
    "",
    instruction,
    "",
  ].join("\n");
}

test("SkillRegistry discovers scopes and selects the highest-priority matching skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "godetx-skills-"));
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(root, "data");
  const builtinRoot = path.join(root, "builtin");
  await mkdir(path.join(builtinRoot, "godot-ui"), { recursive: true });
  await mkdir(path.join(workspace, ".godetx", "skills", "godot-ui"), { recursive: true });
  await writeFile(
    path.join(builtinRoot, "godot-ui", "SKILL.md"),
    skillSource("godot-ui", "Built-in UI workflow", "Control UI", "Use the built-in workflow."),
  );
  await writeFile(
    path.join(workspace, ".godetx", "skills", "godot-ui", "SKILL.md"),
    skillSource("godot-ui", "Project UI workflow", "Control UI", "Use the project-specific workflow."),
  );

  const registry = new SkillRegistry({ workspaceRoot: workspace, dataDirectory, builtinRoot });
  try {
    const snapshot = await registry.refresh();
    assert.equal(snapshot.skills.length, 2);
    assert.deepEqual(snapshot.skills.map((skill) => skill.scope).sort(), ["builtin", "project"]);

    const selection = await registry.resolve(
      "Please build a Control UI for this scene",
      ["project_symbol_search"],
    );
    assert.equal(selection.skills.length, 1);
    assert.equal(selection.skills[0]?.scope, "project");
    assert.match(selection.systemPrompt, /project-specific workflow/u);
    assert.deepEqual(selection.capabilityHints, ["project_symbol_search"]);
    assert.doesNotMatch(selection.systemPrompt, /apply_patch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillRegistry shadows lower scopes by name and can match descriptive metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "godetx-skill-shadow-"));
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(root, "data");
  const builtinRoot = path.join(root, "builtin");
  await mkdir(path.join(builtinRoot, "level-review"), { recursive: true });
  await mkdir(path.join(workspace, ".godetx", "skills", "level-review"), { recursive: true });
  await mkdir(path.join(workspace, ".godetx", "skills", "movement-check"), { recursive: true });
  await writeFile(
    path.join(builtinRoot, "level-review", "SKILL.md"),
    skillSource("level-review", "Inspect platform level collision", "legacy collision pass", "Use the built-in workflow."),
  );
  await writeFile(
    path.join(workspace, ".godetx", "skills", "level-review", "SKILL.md"),
    skillSource("level-review", "Review platform level navigation", "project navigation pass", "Use the project workflow."),
  );
  await writeFile(
    path.join(workspace, ".godetx", "skills", "movement-check", "SKILL.md"),
    skillSource("movement-check", "检查玩家移动状态和碰撞逻辑", "unrelated trigger", "检查移动与碰撞实现。"),
  );

  const registry = new SkillRegistry({ workspaceRoot: workspace, dataDirectory, builtinRoot });
  try {
    const shadowed = await registry.resolve("run the legacy collision pass", ["project_symbol_search"]);
    assert.equal(shadowed.skills.length, 0);

    const explicit = await registry.resolve("Use $level-review for this scene", ["project_symbol_search"]);
    assert.equal(explicit.skills[0]?.scope, "project");

    const descriptive = await registry.resolve("Please review platform navigation before editing", ["project_symbol_search"]);
    assert.equal(descriptive.skills[0]?.id, "project:level-review");

    const chineseDescription = await registry.resolve("请检查玩家移动和碰撞逻辑", ["project_symbol_search"]);
    assert.ok(chineseDescription.skills.some((skill) => skill.id === "project:movement-check"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillRegistry saves, disables, and deletes user-created skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "godetx-skill-save-"));
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  const registry = new SkillRegistry({ workspaceRoot: workspace, dataDirectory, builtinRoot: path.join(root, "builtin") });
  try {
    const saved = await registry.save({
      scope: "project",
      name: "combat-review",
      description: "Review combat scripts",
      instructions: "Inspect damage flow and verify signal connections.",
      triggers: ["combat review"],
      capabilities: ["project_find_references"],
      enabled: true,
    });
    assert.equal(saved.id, "project:combat-review");
    assert.match((await registry.get(saved.id)).instructions, /damage flow/u);

    await registry.setEnabled(saved.id, false);
    const disabledSelection = await registry.resolve("combat review", ["project_find_references"]);
    assert.equal(disabledSelection.skills.length, 0);

    assert.equal(await registry.delete(saved.id), true);
    assert.equal((await registry.refresh()).skills.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skill parser rejects unsupported frontmatter and unsafe names", () => {
  assert.throws(
    () => parseSkill("---\nname: ../bad\ndescription: bad\n---\nInstructions", "project"),
    /Skill name/u,
  );
  assert.throws(
    () => parseSkill("---\nname: valid\ndescription: ok\nauthority: all\n---\nInstructions", "project"),
    /Unsupported frontmatter field/u,
  );
});
