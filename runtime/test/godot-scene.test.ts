import assert from "node:assert/strict";
import test from "node:test";
import { createScenePatch } from "../src/godot-scene.js";

const SCENE = `[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n`;

test("godot scene tool adds a typed node and properties", () => {
  const patch = createScenePatch("main.tscn", SCENE, [
    {
      action: "add_node",
      name: "AgentLabel",
      node_type: "Label",
      parent: ".",
      properties: { text: "Scene edited by GodotX", position: { godot_type: "Vector2", x: 20, y: 30 } },
    },
  ]);
  assert.equal(patch.action, "replace");
  if (patch.action !== "replace") return;
  assert.match(patch.new_text, /\[node name="AgentLabel" type="Label" parent="\."\]/);
  assert.match(patch.new_text, /text = "Scene edited by GodotX"/);
  assert.match(patch.new_text, /position = Vector2\(20, 30\)/);
});

test("godot scene tool serializes strict Color and 3D vector values", () => {
  const patch = createScenePatch("main.tscn", SCENE, [
    {
      action: "add_node",
      name: "Visual",
      node_type: "Node3D",
      parent: ".",
      properties: {
        position: { godot_type: "Vector3", x: 1, y: 2.5, z: -3 },
        modulate: { godot_type: "Color", r: 0.2, g: 0.4, b: 0.8, a: 1 },
      },
    },
  ]);
  if (patch.action !== "replace") return;
  assert.match(patch.new_text, /position = Vector3\(1, 2\.5, -3\)/);
  assert.match(patch.new_text, /modulate = Color\(0\.2, 0\.4, 0\.8, 1\)/);
});

test("godot scene tool safely expands common theme override groups", () => {
  const patch = createScenePatch("main.tscn", SCENE, [
    {
      action: "add_node",
      name: "Description",
      node_type: "Label",
      parent: ".",
      properties: {
        text: "Hello",
        theme_override_colors: {
          font_color: { godot_type: "Color", r: 0.8, g: 0.9, b: 1, a: 1 },
        },
        theme_override_font_sizes: { font_size: 18 },
      },
    },
  ]);
  if (patch.action !== "replace") return;
  assert.match(patch.new_text, /theme_override_colors\/font_color = Color\(0\.8, 0\.9, 1, 1\)/);
  assert.match(patch.new_text, /theme_override_font_sizes\/font_size = 18/);
  assert.doesNotMatch(patch.new_text, /^theme_override_colors =/m);
});

test("godot scene tool updates an existing property", () => {
  const withLabel = `${SCENE}\n[node name="Label" type="Label" parent="."]\ntext = "Before"\n`;
  const patch = createScenePatch("main.tscn", withLabel, [
    { action: "set_property", node_path: "Label", property: "text", value: "After" },
  ]);
  if (patch.action !== "replace") return;
  assert.match(patch.new_text, /text = "After"/);
  assert.doesNotMatch(patch.new_text, /text = "Before"/);
});

test("property insertion stays inside the node section before connections", () => {
  const connected = `${SCENE}\n[connection signal="ready" from="." to="." method="_on_ready"]\n`;
  const patch = createScenePatch("main.tscn", connected, [
    { action: "set_property", node_path: ".", property: "process_mode", value: 3 },
  ]);
  if (patch.action !== "replace") return;
  const propertyIndex = patch.new_text.indexOf("process_mode = 3");
  const connectionIndex = patch.new_text.indexOf("[connection");
  assert.ok(propertyIndex > 0);
  assert.ok(propertyIndex < connectionIndex);
});

test("new nodes are inserted before connection sections", () => {
  const connected = `${SCENE}\n[connection signal="ready" from="." to="." method="_on_ready"]\n`;
  const patch = createScenePatch("main.tscn", connected, [
    { action: "add_node", name: "Child", node_type: "Node", parent: "." },
  ]);
  if (patch.action !== "replace") return;
  assert.ok(patch.new_text.indexOf('[node name="Child"') < patch.new_text.indexOf("[connection"));
});

test("godot scene tool rejects ambiguous and malformed property objects", () => {
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      { action: "set_property", node_path: ".", property: "position", value: { x: 1, y: 2 } },
    ]),
    /Unsupported Godot property object.*tagged/s,
  );
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      {
        action: "set_property",
        node_path: ".",
        property: "modulate",
        value: { godot_type: "Color", r: 1, g: 1, b: 1 },
      },
    ]),
    /modulate\.a must be a finite number/,
  );
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      {
        action: "set_property",
        node_path: ".",
        property: "position",
        value: { godot_type: "Vector2i", x: 1.5, y: 2 },
      },
    ]),
    /Vector2i\.x must be an integer/,
  );
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      { action: "set_property", node_path: ".", property: "values", value: [[1, 2]] },
    ]),
    /Nested Godot property arrays are not supported/,
  );
});

test("theme override compatibility validates group-specific values", () => {
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      {
        action: "set_property",
        node_path: ".",
        property: "theme_override_colors",
        value: { font_color: "white" },
      },
    ]),
    /must use a tagged Color/,
  );
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      {
        action: "set_property",
        node_path: ".",
        property: "theme_override_font_sizes",
        value: { font_size: 18.5 },
      },
    ]),
    /must be a non-negative integer/,
  );
});

test("set_property refuses to corrupt an existing multi-line value", () => {
  const withMultiline = `${SCENE.trimEnd()}\nvalues = [\n1,\n2,\n]\n`;
  assert.throws(
    () => createScenePatch("main.tscn", withMultiline, [
      { action: "set_property", node_path: ".", property: "values", value: [3, 4] },
    ]),
    /Cannot safely replace multi-line Godot property/,
  );
});

test("scene paths and property names reject traversal-like syntax", () => {
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      { action: "set_property", node_path: "../Main", property: "text", value: "bad" },
    ]),
    /Invalid node path/,
  );
  assert.throws(
    () => createScenePatch("main.tscn", SCENE, [
      { action: "set_property", node_path: ".", property: "theme_override_colors//font_color", value: 1 },
    ]),
    /Invalid property name/,
  );
});
