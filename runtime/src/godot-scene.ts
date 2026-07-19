import type { PatchOperation } from "./workspace.js";

export type GodotSceneOperation =
  | {
      action: "add_node";
      name: string;
      node_type: string;
      parent: string;
      properties?: Record<string, unknown>;
    }
  | {
      action: "set_property";
      node_path: string;
      property: string;
      value: unknown;
    };

const FLATTENABLE_PROPERTY_GROUPS = new Set([
  "theme_override_colors",
  "theme_override_constants",
  "theme_override_font_sizes",
]);

export function createScenePatch(
  scenePath: string,
  content: string,
  operations: GodotSceneOperation[],
): PatchOperation {
  if (!content.includes("[gd_scene")) throw new Error(`${scenePath} is not a Godot text scene`);
  let updated = content;
  for (const operation of operations) {
    updated = operation.action === "add_node" ? addNode(updated, operation) : setProperty(updated, operation);
  }
  return { action: "replace", path: scenePath, old_text: content, new_text: updated };
}

function addNode(
  content: string,
  operation: Extract<GodotSceneOperation, { action: "add_node" }>,
): string {
  validateIdentifier(operation.name, "node name");
  validateIdentifier(operation.node_type, "node type");
  validateNodePath(operation.parent, "parent path");
  if (!nodeExists(content, operation.parent)) throw new Error(`Parent node does not exist: ${operation.parent}`);
  const newPath = operation.parent === "." ? operation.name : `${operation.parent}/${operation.name}`;
  if (nodeExists(content, newPath)) throw new Error(`Node already exists: ${newPath}`);

  const lines = [
    `[node name=${JSON.stringify(operation.name)} type=${JSON.stringify(operation.node_type)} parent=${JSON.stringify(operation.parent)}]`,
  ];
  if (operation.properties !== undefined && !isRecord(operation.properties)) {
    throw new Error("Godot node properties must be an object");
  }
  for (const [property, value] of Object.entries(operation.properties ?? {})) {
    for (const assignment of expandPropertyAssignments(property, value)) {
      lines.push(`${assignment.property} = ${toGodotLiteral(assignment.value, assignment.property)}`);
    }
  }
  const trailingSection = /^\[(?:connection|editable)\b[^\]]*\]\s*$/m.exec(content);
  const insertion = trailingSection?.index ?? content.length;
  const before = content.slice(0, insertion).trimEnd();
  const after = content.slice(insertion).trimStart();
  return `${before}\n\n${lines.join("\n")}\n${after ? `\n${after}\n` : ""}`;
}

function setProperty(
  content: string,
  operation: Extract<GodotSceneOperation, { action: "set_property" }>,
): string {
  validateNodePath(operation.node_path, "node path");
  const section = findNodeSection(content, operation.node_path);
  if (!section) throw new Error(`Node does not exist: ${operation.node_path}`);
  const before = content.slice(0, section.start);
  const body = content.slice(section.start, section.end);
  const after = content.slice(section.end);
  let nextBody = body;
  for (const assignment of expandPropertyAssignments(operation.property, operation.value)) {
    const linePattern = new RegExp(`^${escapeRegExp(assignment.property)}\\s*=.*$`, "m");
    const serialized = `${assignment.property} = ${toGodotLiteral(assignment.value, assignment.property)}`;
    const existing = linePattern.exec(nextBody);
    if (existing) {
      assertSingleLineValue(existing[0], assignment.property);
      nextBody = nextBody.replace(linePattern, serialized);
    } else {
      nextBody = `${nextBody.trimEnd()}\n${serialized}\n`;
    }
  }
  return before + nextBody + after;
}

function nodeExists(content: string, nodePath: string): boolean {
  return Boolean(findNodeSection(content, nodePath));
}

function findNodeSection(content: string, nodePath: string): { start: number; end: number } | undefined {
  const sectionPattern = /^\[node\s+([^\]]+)\]\s*$/gm;
  const matches = [...content.matchAll(sectionPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const attrs = match[1] ?? "";
    const name = readAttribute(attrs, "name");
    const parent = readAttribute(attrs, "parent");
    const currentPath = parent === undefined ? "." : parent === "." ? name : `${parent}/${name}`;
    if (currentPath !== nodePath) continue;
    const nextSectionPattern = /^\[[^\]]+\]\s*$/gm;
    nextSectionPattern.lastIndex = match.index + match[0].length;
    const nextSection = nextSectionPattern.exec(content);
    return {
      start: match.index,
      end: nextSection?.index ?? content.length,
    };
  }
  return undefined;
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}=("(?:[^"\\\\]|\\\\.)*")`));
  if (!match?.[1]) return undefined;
  return JSON.parse(match[1]) as string;
}

function expandPropertyAssignments(
  property: string,
  value: unknown,
): Array<{ property: string; value: unknown }> {
  validateProperty(property);
  if (!FLATTENABLE_PROPERTY_GROUPS.has(property)) {
    return [{ property, value }];
  }
  if (!isRecord(value) || typeof value.godot_type === "string") {
    throw new Error(`${property} must be an object whose keys name individual theme overrides`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`Godot property group must not be empty: ${property}`);
  if (entries.length > 64) throw new Error(`Godot property group exceeds 64 entries: ${property}`);
  return entries.map(([child, childValue]) => {
    const expanded = `${property}/${child}`;
    validateProperty(expanded);
    validatePropertyGroupValue(property, childValue, expanded);
    return { property: expanded, value: childValue };
  });
}

function validatePropertyGroupValue(group: string, value: unknown, property: string): void {
  if (group === "theme_override_colors") {
    if (!isRecord(value) || value.godot_type !== "Color") {
      throw new Error(`${property} must use a tagged Color value`);
    }
    return;
  }
  if (group === "theme_override_font_sizes") {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${property} must be a non-negative integer`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${property} must be an integer`);
  }
}

function toGodotLiteral(value: unknown, property = "value", arrayDepth = 0): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Godot property numbers must be finite: ${property}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (arrayDepth >= 1) throw new Error(`Nested Godot property arrays are not supported: ${property}`);
    if (value.length > 256) throw new Error(`Godot property array exceeds 256 items: ${property}`);
    return `[${value.map((entry, index) => toGodotLiteral(entry, `${property}[${index}]`, arrayDepth + 1)).join(", ")}]`;
  }
  if (isRecord(value)) {
    const record = value;
    switch (record.godot_type) {
      case "Vector2":
        return numericConstructor(record, "Vector2", ["x", "y"], property);
      case "Vector2i":
        return numericConstructor(record, "Vector2i", ["x", "y"], property, true);
      case "Vector3":
        return numericConstructor(record, "Vector3", ["x", "y", "z"], property);
      case "Vector3i":
        return numericConstructor(record, "Vector3i", ["x", "y", "z"], property, true);
      case "Color": {
        validateObjectKeys(record, ["godot_type", "r", "g", "b", "a"], property);
        const components = ["r", "g", "b"].map((field) => finiteNumber(record[field], `${property}.${field}`));
        components.push(finiteNumber(record.a, `${property}.a`));
        return `Color(${components.join(", ")})`;
      }
      default:
        throw new Error(
          `Unsupported Godot property object at "${property}". Use a primitive, array, or a tagged ` +
            "Vector2, Vector2i, Vector3, Vector3i, or Color value. " +
            'Use flat property keys such as "theme_override_font_sizes/font_size".',
        );
    }
  }
  throw new Error(`Unsupported Godot property type: ${typeof value}`);
}

function numericConstructor(
  record: Record<string, unknown>,
  type: string,
  fields: string[],
  property: string,
  integers = false,
): string {
  validateObjectKeys(record, ["godot_type", ...fields], property);
  const values = fields.map((field) => {
    const value = finiteNumber(record[field], `${property}.${field}`);
    if (integers && !Number.isInteger(value)) throw new Error(`${type}.${field} must be an integer: ${property}`);
    return value;
  });
  return `${type}(${values.join(", ")})`;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function validateObjectKeys(record: Record<string, unknown>, allowed: string[], property: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`Unexpected field "${unexpected}" in Godot value for "${property}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function validateProperty(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error(`Invalid property name: ${value}`);
  }
}

function validateNodePath(value: string, label: string): void {
  if (value === ".") return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertSingleLineValue(assignment: string, property: string): void {
  const separator = assignment.indexOf("=");
  const value = separator >= 0 ? assignment.slice(separator + 1).trim() : "";
  if (!value || !hasBalancedDelimiters(value)) {
    throw new Error(`Cannot safely replace multi-line Godot property: ${property}`);
  }
}

function hasBalancedDelimiters(value: string): boolean {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  const matching: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const char of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (["(", "[", "{"].includes(char)) stack.push(char);
    else if (matching[char]) {
      if (stack.pop() !== matching[char]) return false;
    }
  }
  return !quoted && !escaped && stack.length === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
