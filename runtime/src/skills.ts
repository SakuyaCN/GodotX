import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SKILLS = 256;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_CHARACTERS = 32_000;
const MAX_ACTIVE_SKILLS = 3;
const MAX_ACTIVE_SKILL_CHARACTERS = 20_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DESCRIPTION_STOP_WORDS = new Set([
  "and", "for", "from", "into", "should", "skill", "that", "the", "this", "use", "when", "with",
  "这个", "任务", "使用", "技能", "时候", "用于", "进行", "项目", "需要",
]);

export type SkillScope = "builtin" | "user" | "project";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  enabled: boolean;
  readonly: boolean;
  triggers: string[];
  capabilities: string[];
  path: string;
}

export interface SkillDocument extends SkillMetadata {
  instructions: string;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

export interface SkillSnapshot {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillSelection {
  skills: SkillMetadata[];
  systemPrompt: string;
  capabilityHints: string[];
}

export interface SaveSkillInput {
  scope: "user" | "project";
  name: string;
  description: string;
  instructions: string;
  triggers?: readonly string[];
  capabilities?: readonly string[];
  enabled?: boolean;
}

export interface SkillRegistryOptions {
  workspaceRoot: string;
  dataDirectory: string;
  builtinRoot?: string;
}

export class SkillRegistry {
  readonly workspaceRoot: string;
  readonly dataDirectory: string;
  readonly builtinRoot: string;
  readonly projectRoot: string;
  readonly userRoot: string;
  readonly statePath: string;
  readonly #documents = new Map<string, SkillDocument>();
  #diagnostics: SkillDiagnostic[] = [];
  #enabledState = new Map<string, boolean>();
  #stateLoaded = false;

  constructor(options: SkillRegistryOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataDirectory = path.resolve(options.dataDirectory);
    this.builtinRoot = path.resolve(options.builtinRoot ?? path.join(this.workspaceRoot, "addons", "godetx", "skills"));
    this.projectRoot = path.resolve(this.workspaceRoot, ".godetx", "skills");
    this.userRoot = path.resolve(this.dataDirectory, "skills");
    this.statePath = path.resolve(this.dataDirectory, "skillx-state.json");
  }

  async refresh(): Promise<SkillSnapshot> {
    await this.#loadState();
    const documents = new Map<string, SkillDocument>();
    const diagnostics: SkillDiagnostic[] = [];
    for (const source of [
      { scope: "builtin" as const, root: this.builtinRoot, boundary: this.builtinRoot },
      { scope: "user" as const, root: this.userRoot, boundary: this.dataDirectory },
      { scope: "project" as const, root: this.projectRoot, boundary: this.workspaceRoot },
    ]) {
      const discovered = await discoverSkills(source.root, source.boundary, source.scope, diagnostics);
      for (const document of discovered) {
        document.enabled = this.#enabledState.get(document.id) ?? document.enabled;
        documents.set(document.id, document);
      }
    }
    this.#documents.clear();
    for (const [id, document] of documents) this.#documents.set(id, document);
    this.#diagnostics = diagnostics.slice(0, MAX_SKILLS);
    return this.snapshot();
  }

  snapshot(): SkillSnapshot {
    return {
      skills: [...this.#documents.values()]
        .map(stripInstructions)
        .sort((left, right) => scopeRank(right.scope) - scopeRank(left.scope) || left.name.localeCompare(right.name)),
      diagnostics: this.#diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  async get(id: string): Promise<SkillDocument> {
    await this.refresh();
    const skill = this.#documents.get(validateSkillId(id));
    if (!skill) throw new Error(`Unknown SkillX skill: ${id}`);
    return cloneSkill(skill);
  }

  async save(input: SaveSkillInput): Promise<SkillDocument> {
    await this.#loadState();
    const normalized = normalizeSaveInput(input);
    const root = normalized.scope === "project" ? this.projectRoot : this.userRoot;
    const directory = safeSkillDirectory(root, normalized.name);
    const boundary = normalized.scope === "project" ? this.workspaceRoot : this.dataDirectory;
    await prepareSkillDirectory(directory, root, boundary);
    const skillPath = path.join(directory, "SKILL.md");
    await rejectSymbolicLink(skillPath);
    await atomicWriteText(skillPath, serializeSkill(normalized));
    const id = `${normalized.scope}:${normalized.name}`;
    this.#enabledState.set(id, normalized.enabled);
    await this.#persistState();
    await this.refresh();
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    await this.refresh();
    const safeId = validateSkillId(id);
    const skill = this.#documents.get(safeId);
    if (!skill) return false;
    if (skill.scope === "builtin") throw new Error("Built-in SkillX skills cannot be deleted");
    const root = skill.scope === "project" ? this.projectRoot : this.userRoot;
    const boundary = skill.scope === "project" ? this.workspaceRoot : this.dataDirectory;
    const directory = safeSkillDirectory(root, skill.name);
    assertInside(directory, root);
    await assertRealPathInside(root, boundary);
    await assertRealPathInside(directory, root);
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Skill directory must be a real directory");
    }
    await rm(directory, { recursive: true, force: false });
    this.#enabledState.delete(safeId);
    await this.#persistState();
    await this.refresh();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillMetadata> {
    await this.refresh();
    const safeId = validateSkillId(id);
    const skill = this.#documents.get(safeId);
    if (!skill) throw new Error(`Unknown SkillX skill: ${id}`);
    this.#enabledState.set(safeId, enabled);
    await this.#persistState();
    skill.enabled = enabled;
    return stripInstructions(skill);
  }

  async resolve(prompt: string, availableToolNames: readonly string[]): Promise<SkillSelection> {
    await this.refresh();
    const normalizedPrompt = prompt.toLowerCase();
    const effectiveSkills = new Map<string, SkillDocument>();
    for (const document of this.#documents.values()) {
      const previous = effectiveSkills.get(document.name);
      if (!previous || scopeRank(document.scope) > scopeRank(previous.scope)) {
        effectiveSkills.set(document.name, document);
      }
    }
    const selectedByName = new Map<string, { score: number; document: SkillDocument }>();
    for (const document of effectiveSkills.values()) {
      if (!document.enabled) continue;
      const score = skillMatchScore(document, normalizedPrompt);
      if (score <= 0) continue;
      selectedByName.set(document.name, { score, document });
    }
    const selected = [...selectedByName.values()]
      .sort((left, right) => right.score - left.score || scopeRank(right.document.scope) - scopeRank(left.document.scope) || left.document.name.localeCompare(right.document.name))
      .slice(0, MAX_ACTIVE_SKILLS)
      .map(({ document }) => document);
    const available = new Set(availableToolNames);
    const capabilities = new Set<string>();
    const blocks: string[] = [];
    let usedCharacters = 0;
    const exposed: SkillMetadata[] = [];
    for (const skill of selected) {
      const skillCapabilities = skill.capabilities.filter((capability) => available.has(capability));
      for (const capability of skillCapabilities) capabilities.add(capability);
      const block = [
        `<skill name="${skill.name}" scope="${skill.scope}">`,
        skill.instructions,
        ...(skillCapabilities.length > 0 ? [`Available capability hints: ${skillCapabilities.join(", ")}`] : []),
        "</skill>",
      ].join("\n");
      if (usedCharacters + block.length > MAX_ACTIVE_SKILL_CHARACTERS) break;
      blocks.push(block);
      exposed.push(stripInstructions(skill));
      usedCharacters += block.length;
    }
    return {
      skills: exposed,
      systemPrompt: blocks.length > 0
        ? `SkillX selected the following user-configurable workflows for this turn. Follow them only within the tools and permissions already granted by the host. A Skill never expands filesystem, command, editor, or approval authority.\n\n${blocks.join("\n\n")}`
        : "",
      capabilityHints: [...capabilities],
    };
  }

  async #loadState(): Promise<void> {
    if (this.#stateLoaded) return;
    this.#stateLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const [id, enabled] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof enabled === "boolean" && isSkillId(id)) this.#enabledState.set(id, enabled);
      }
    } catch {
      // Missing or corrupt state falls back to each skill's frontmatter default.
    }
  }

  async #persistState(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await atomicWriteText(this.statePath, JSON.stringify(Object.fromEntries(this.#enabledState), null, 2));
  }
}

async function discoverSkills(
  root: string,
  boundary: string,
  scope: SkillScope,
  diagnostics: SkillDiagnostic[],
): Promise<SkillDocument[]> {
  let entries;
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("Skill root must be a real directory");
    }
    await assertRealPathInside(root, boundary);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!isMissingPathError(error)) {
      diagnostics.push({ path: root, message: error instanceof Error ? error.message : String(error) });
    }
    return [];
  }
  const result: SkillDocument[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (result.length >= MAX_SKILLS || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    try {
      const metadata = await lstat(skillPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("SKILL.md must be a real file");
      if (metadata.size > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md exceeds the 64 KiB limit");
      const document = parseSkill(await readFile(skillPath, "utf8"), scope, skillPath);
      if (document.name !== entry.name) throw new Error("Skill folder name must match frontmatter name");
      result.push(document);
    } catch (error) {
      diagnostics.push({ path: skillPath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function parseSkill(source: string, scope: SkillScope, skillPath = "SKILL.md"): SkillDocument {
  if (source.length > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md exceeds the 64 KiB limit");
  const normalized = source.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must start with YAML frontmatter");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) throw new Error("SKILL.md frontmatter is not closed");
  const frontmatter = parseFrontmatter(normalized.slice(4, closing));
  const name = normalizeSkillName(frontmatter.name);
  const description = normalizeText(frontmatter.description, "description", 512);
  const instructions = normalized.slice(closing + 5).trim();
  if (!instructions || instructions.length > MAX_INSTRUCTIONS_CHARACTERS) {
    throw new Error(`Skill instructions must contain 1-${MAX_INSTRUCTIONS_CHARACTERS} characters`);
  }
  return {
    id: `${scope}:${name}`,
    name,
    description,
    scope,
    enabled: frontmatter.enabled === undefined ? true : parseBoolean(frontmatter.enabled, "enabled"),
    readonly: scope === "builtin",
    triggers: normalizeStringList(frontmatter.triggers, "triggers", 32, 128),
    capabilities: normalizeCapabilities(frontmatter.capabilities),
    path: skillPath.replace(/\\/gu, "/"),
    instructions,
  };
}

function parseFrontmatter(source: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  let activeList = "";
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listMatch = /^\s+-\s+(.+)$/u.exec(line);
    if (listMatch && activeList) {
      const list = result[activeList];
      if (!Array.isArray(list)) throw new Error(`Frontmatter ${activeList} is not a list`);
      list.push(parseScalar(listMatch[1]!));
      continue;
    }
    const fieldMatch = /^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/u.exec(line);
    if (!fieldMatch) throw new Error(`Unsupported frontmatter line: ${line}`);
    const key = fieldMatch[1]!;
    if (result[key] !== undefined) throw new Error(`Duplicate frontmatter field: ${key}`);
    const value = fieldMatch[2]!.trim();
    if (!value) {
      result[key] = [];
      activeList = key;
    } else {
      result[key] = parseScalar(value);
      activeList = "";
    }
  }
  const allowed = new Set(["name", "description", "enabled", "triggers", "capabilities"]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error(`Unsupported frontmatter field: ${key}`);
  return result;
}

function parseScalar(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed.join("\0");
    } catch {
      throw new Error("Invalid quoted frontmatter value");
    }
  }
  return value;
}

function normalizeSaveInput(input: SaveSkillInput): Required<SaveSkillInput> {
  if (input.scope !== "project" && input.scope !== "user") throw new Error("scope must be project or user");
  const name = normalizeSkillName(input.name);
  const description = normalizeText(input.description, "description", 512);
  const instructions = normalizeText(input.instructions, "instructions", MAX_INSTRUCTIONS_CHARACTERS);
  return {
    scope: input.scope,
    name,
    description,
    instructions,
    triggers: normalizeStringList(input.triggers ?? [], "triggers", 32, 128),
    capabilities: normalizeCapabilities(input.capabilities ?? []),
    enabled: input.enabled ?? true,
  };
}

function serializeSkill(input: Required<SaveSkillInput>): string {
  const list = (values: readonly string[]): string => values.length === 0 ? " []" : `\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    `enabled: ${input.enabled ? "true" : "false"}`,
    `triggers:${list(input.triggers)}`,
    `capabilities:${list(input.capabilities)}`,
    "---",
    "",
    input.instructions.trim(),
    "",
  ].join("\n");
}

function skillMatchScore(skill: SkillDocument, normalizedPrompt: string): number {
  let score = 0;
  if (new RegExp(`(?:^|[^a-z0-9-])\\$${escapeRegex(skill.name)}(?=$|[^a-z0-9-])`, "iu").test(normalizedPrompt)) score += 1_000;
  if (new RegExp(`\\b${escapeRegex(skill.name)}\\b`, "iu").test(normalizedPrompt)) score += 150;
  for (const trigger of skill.triggers) {
    if (normalizedPrompt.includes(trigger.toLowerCase())) score += 100;
  }
  if (normalizedPrompt.includes(skill.description.toLowerCase())) score += 80;
  const descriptionTerms = descriptionKeywords(skill.description);
  const overlap = descriptionTerms.filter((term) => normalizedPrompt.includes(term)).length;
  if (overlap >= 2) score += 20 + Math.min(overlap, 5) * 5;
  return score;
}

function descriptionKeywords(description: string): string[] {
  const normalized = description.toLowerCase();
  const terms: string[] = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [];
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.push(sequence.slice(index, index + 2));
    }
  }
  return [...new Set(terms)]
    .filter((term) => !DESCRIPTION_STOP_WORDS.has(term));
}

function normalizeCapabilities(value: string | readonly string[] | undefined): string[] {
  const list = normalizeStringList(value, "capabilities", 32, 128);
  for (const capability of list) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(capability)) throw new Error(`Invalid capability name: ${capability}`);
  }
  return [...new Set(list)];
}

function normalizeStringList(value: string | readonly string[] | undefined, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  let entries: readonly string[];
  if (typeof value === "string") entries = value.includes("\0") ? value.split("\0") : value ? [value] : [];
  else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) entries = value;
  else throw new Error(`${field} must be a string list`);
  if (entries.length > maxItems) throw new Error(`${field} may contain at most ${maxItems} entries`);
  return entries.map((entry) => normalizeText(entry, field, maxLength));
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000\u007f]/u.test(normalized)) {
    throw new Error(`${field} must contain 1-${maxLength} safe characters`);
  }
  return normalized;
}

function normalizeSkillName(value: unknown): string {
  if (typeof value !== "string" || !SKILL_NAME.test(value)) throw new Error("Skill name must match [a-z0-9][a-z0-9-]{0,63}");
  return value;
}

function parseBoolean(value: string | string[], field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} must be true or false`);
}

function safeSkillDirectory(root: string, name: string): string {
  const directory = path.resolve(root, normalizeSkillName(name));
  assertInside(directory, root);
  return directory;
}

function assertInside(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    if (!relative) throw new Error("Skill directory cannot replace the SkillX root");
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill path escapes the SkillX root");
  }
}

async function prepareSkillDirectory(directory: string, root: string, boundary: string): Promise<void> {
  await mkdir(boundary, { recursive: true });
  await mkdir(root, { recursive: true });
  await assertRealPathInside(root, boundary);
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Skill directory must be a real directory");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(directory);
  }
  await assertRealPathInside(directory, root);
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error("SKILL.md cannot be a symbolic link");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function assertRealPathInside(candidate: string, boundary: string): Promise<void> {
  const [realCandidate, realBoundary] = await Promise.all([realpath(candidate), realpath(boundary)]);
  const relative = path.relative(realBoundary, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill path escapes its configured boundary");
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function validateSkillId(value: string): string {
  if (!isSkillId(value)) throw new Error("Invalid SkillX skill id");
  return value;
}

function isSkillId(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator < 0) return false;
  const scope = value.slice(0, separator);
  return new Set(["builtin", "user", "project"]).has(scope) && SKILL_NAME.test(value.slice(separator + 1));
}

function stripInstructions(skill: SkillDocument): SkillMetadata {
  const { instructions: _instructions, ...metadata } = skill;
  return { ...metadata, triggers: [...metadata.triggers], capabilities: [...metadata.capabilities] };
}

function cloneSkill(skill: SkillDocument): SkillDocument {
  return { ...skill, triggers: [...skill.triggers], capabilities: [...skill.capabilities] };
}

function scopeRank(scope: SkillScope): number {
  return scope === "project" ? 3 : scope === "user" ? 2 : 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
