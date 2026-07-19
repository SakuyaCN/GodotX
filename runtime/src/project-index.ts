import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const INDEX_VERSION = 1;
const MAX_INDEX_FILES = 10_000;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCES_PER_FILE = 12_000;
const MAX_QUERY_RESULTS = 500;
const MAX_INDEX_SYMBOLS = 100_000;
const MAX_INDEX_REFERENCES = 250_000;
const MAX_INDEX_DEPENDENCIES = 100_000;
const MAX_INDEX_CACHE_BYTES = 128 * 1024 * 1024;
const INDEXED_EXTENSIONS = new Set([".gd", ".gdshader", ".tscn", ".tres", ".godot"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".godot",
  ".godetx",
  "node_modules",
  "output",
  "dist",
  "build",
]);
const GDSCRIPT_KEYWORDS = new Set([
  "and", "as", "assert", "await", "break", "breakpoint", "class", "class_name", "const",
  "continue", "elif", "else", "enum", "extends", "false", "for", "func", "if", "in", "is",
  "match", "namespace", "not", "null", "or", "pass", "preload", "return", "self", "signal",
  "static", "super", "true", "var", "void", "when", "while", "yield",
]);
const SEMANTIC_SYMBOL_KINDS = new Set<string>([
  "class", "method", "signal", "variable", "constant", "enum", "shader", "uniform",
  "scene_node", "resource", "autoload", "input_action", "section",
]);

export type SemanticSymbolKind =
  | "class"
  | "method"
  | "signal"
  | "variable"
  | "constant"
  | "enum"
  | "shader"
  | "uniform"
  | "scene_node"
  | "resource"
  | "autoload"
  | "input_action"
  | "section";

export interface SemanticSymbol {
  name: string;
  kind: SemanticSymbolKind;
  path: string;
  line: number;
  column: number;
  detail?: string;
}

export interface SemanticReference {
  name: string;
  path: string;
  line: number;
  column: number;
  kind: "identifier" | "resource_path" | "node_path";
  definition?: boolean;
}

interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  kind: string;
  symbols: SemanticSymbol[];
  references: SemanticReference[];
  dependencies: string[];
}

interface PersistedIndex {
  version: number;
  lastIndexedAt: string;
  files: IndexedFile[];
}

export interface ProjectIndexStatus {
  state: "idle" | "scanning" | "ready" | "failed";
  fileCount: number;
  symbolCount: number;
  referenceCount: number;
  dependencyCount: number;
  lastIndexedAt: string | null;
  scanDurationMs: number;
  truncated: boolean;
  error?: string;
}

export interface SymbolSearchOptions {
  kinds?: readonly string[];
  pathPrefix?: string;
  limit?: number;
}

export interface ReferenceSearchOptions {
  pathPrefix?: string;
  limit?: number;
}

export interface DependencyGraphOptions {
  direction?: "dependencies" | "dependents" | "both";
  depth?: number;
  limit?: number;
}

export interface ProjectFileOverview {
  path: string;
  kind: string;
  size: number;
  mtimeMs: number;
  symbols: SemanticSymbol[];
  dependencies: string[];
}

export class ProjectIndex {
  readonly workspaceRoot: string;
  readonly cachePath: string;
  readonly #files = new Map<string, IndexedFile>();
  readonly #references = new Map<string, SemanticReference[]>();
  readonly #dependents = new Map<string, Set<string>>();
  #watcher: FSWatcher | undefined;
  #watchTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<ProjectIndexStatus> | undefined;
  #dirty = true;
  #disposed = false;
  #truncated = false;
  #status: ProjectIndexStatus = {
    state: "idle",
    fileCount: 0,
    symbolCount: 0,
    referenceCount: 0,
    dependencyCount: 0,
    lastIndexedAt: null,
    scanDurationMs: 0,
    truncated: false,
  };

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.cachePath = path.join(this.workspaceRoot, ".godot", "godetx", "semantic-index-v1.json");
  }

  async initialize(): Promise<ProjectIndexStatus> {
    await this.#loadCache();
    this.#startWatcher();
    return this.refresh();
  }

  status(): ProjectIndexStatus {
    return { ...this.#status };
  }

  markDirty(): void {
    this.#dirty = true;
  }

  async refresh(force = false): Promise<ProjectIndexStatus> {
    if (this.#disposed) throw new Error("Project index is disposed");
    if (!force && !this.#dirty && this.#status.state === "ready" && this.#watcher) {
      return this.status();
    }
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#scan(force).finally(() => {
      this.#refreshPromise = undefined;
    });
    return this.#refreshPromise;
  }

  async rebuild(): Promise<ProjectIndexStatus> {
    this.#files.clear();
    this.#references.clear();
    this.#dependents.clear();
    this.#dirty = true;
    this.#truncated = false;
    return this.refresh(true);
  }

  async searchSymbols(query: string, options: SymbolSearchOptions = {}): Promise<SemanticSymbol[]> {
    await this.refresh();
    const needle = normalizeQuery(query, "query", 256).toLowerCase();
    const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
    const pathPrefix = normalizeOptionalPrefix(options.pathPrefix);
    const limit = boundedLimit(options.limit, 100);
    const ranked: Array<{ score: number; symbol: SemanticSymbol }> = [];
    for (const file of this.#files.values()) {
      if (pathPrefix && !file.path.toLowerCase().startsWith(pathPrefix)) continue;
      for (const symbol of file.symbols) {
        if (kinds && !kinds.has(symbol.kind)) continue;
        const name = symbol.name.toLowerCase();
        const detail = symbol.detail?.toLowerCase() ?? "";
        const pathValue = symbol.path.toLowerCase();
        let score = 0;
        if (name === needle) score = 100;
        else if (name.startsWith(needle)) score = 80;
        else if (name.includes(needle)) score = 60;
        else if (detail.includes(needle)) score = 30;
        else if (pathValue.includes(needle)) score = 20;
        if (score > 0) ranked.push({ score, symbol });
      }
    }
    return ranked
      .sort((left, right) => right.score - left.score || left.symbol.path.localeCompare(right.symbol.path) || left.symbol.line - right.symbol.line)
      .slice(0, limit)
      .map(({ symbol }) => ({ ...symbol }));
  }

  async findReferences(name: string, options: ReferenceSearchOptions = {}): Promise<SemanticReference[]> {
    await this.refresh();
    const query = normalizeQuery(name, "name", 256);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(query) && !query.startsWith("res://")) {
      throw new Error("name must be a Godot identifier or res:// resource path");
    }
    const pathPrefix = normalizeOptionalPrefix(options.pathPrefix);
    const limit = boundedLimit(options.limit, 200);
    const key = referenceKey(query);
    return (this.#references.get(key) ?? [])
      .filter((reference) => !pathPrefix || reference.path.toLowerCase().startsWith(pathPrefix))
      .slice(0, limit)
      .map((reference) => ({ ...reference }));
  }

  async getFileOverview(filePath: string): Promise<ProjectFileOverview | undefined> {
    await this.refresh();
    const normalized = normalizeProjectPath(filePath);
    const file = this.#files.get(normalized);
    if (!file) return undefined;
    return {
      path: file.path,
      kind: file.kind,
      size: file.size,
      mtimeMs: file.mtimeMs,
      symbols: file.symbols.map((symbol) => ({ ...symbol })),
      dependencies: [...file.dependencies],
    };
  }

  async dependencyGraph(rootPath: string, options: DependencyGraphOptions = {}): Promise<{
    root: string;
    nodes: Array<{ path: string; kind: string; exists: boolean }>;
    edges: Array<{ from: string; to: string }>;
    truncated: boolean;
  }> {
    await this.refresh();
    const root = normalizeProjectPath(rootPath);
    const direction = options.direction ?? "both";
    if (!new Set(["dependencies", "dependents", "both"]).has(direction)) {
      throw new Error("direction must be dependencies, dependents, or both");
    }
    const maxDepth = Math.min(Math.max(options.depth ?? 3, 1), 8);
    const limit = boundedLimit(options.limit, 200);
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const visited = new Set<string>();
    const edges = new Map<string, { from: string; to: string }>();
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.path)) continue;
      if (visited.size >= limit) {
        truncated = true;
        break;
      }
      visited.add(current.path);
      if (current.depth >= maxDepth) continue;
      const next = new Set<string>();
      if (direction !== "dependents") {
        for (const dependency of this.#files.get(current.path)?.dependencies ?? []) {
          edges.set(`${current.path}\0${dependency}`, { from: current.path, to: dependency });
          next.add(dependency);
        }
      }
      if (direction !== "dependencies") {
        for (const dependent of this.#dependents.get(current.path) ?? []) {
          edges.set(`${dependent}\0${current.path}`, { from: dependent, to: current.path });
          next.add(dependent);
        }
      }
      for (const candidate of next) queue.push({ path: candidate, depth: current.depth + 1 });
    }
    return {
      root,
      nodes: [...visited].sort().map((entryPath) => ({
        path: entryPath,
        kind: this.#files.get(entryPath)?.kind ?? extensionKind(entryPath),
        exists: this.#files.has(entryPath),
      })),
      edges: [...edges.values()].filter((edge) => visited.has(edge.from) && visited.has(edge.to)),
      truncated,
    };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  async #scan(force: boolean): Promise<ProjectIndexStatus> {
    const startedAt = Date.now();
    const { error: _previousError, ...previousStatus } = this.#status;
    this.#status = { ...previousStatus, state: "scanning" };
    try {
      const candidates = await collectIndexCandidates(this.workspaceRoot);
      const seen = new Set<string>();
      let changed = force;
      const totals = this.#applyGlobalLimits();
      this.#truncated = totals.truncated;
      for (const candidate of candidates) {
        seen.add(candidate.path);
        const previous = this.#files.get(candidate.path);
        if (!force && previous && previous.size === candidate.size && previous.mtimeMs === candidate.mtimeMs) continue;
        if (previous) {
          totals.symbols -= previous.symbols.length;
          totals.references -= previous.references.length;
          totals.dependencies -= previous.dependencies.length;
        }
        const content = await readFile(candidate.absolutePath, "utf8");
        const parsed = parseIndexedFile(candidate.path, candidate.size, candidate.mtimeMs, content);
        const limited = limitIndexedFile(parsed, {
          symbols: MAX_INDEX_SYMBOLS - totals.symbols,
          references: MAX_INDEX_REFERENCES - totals.references,
          dependencies: MAX_INDEX_DEPENDENCIES - totals.dependencies,
        });
        this.#files.set(candidate.path, limited.file);
        totals.symbols += limited.file.symbols.length;
        totals.references += limited.file.references.length;
        totals.dependencies += limited.file.dependencies.length;
        this.#truncated ||= limited.truncated;
        changed = true;
      }
      for (const indexedPath of [...this.#files.keys()]) {
        if (!seen.has(indexedPath)) {
          const removed = this.#files.get(indexedPath);
          if (removed) {
            totals.symbols -= removed.symbols.length;
            totals.references -= removed.references.length;
            totals.dependencies -= removed.dependencies.length;
          }
          this.#files.delete(indexedPath);
          changed = true;
        }
      }
      this.#rebuildLookups();
      const lastIndexedAt = new Date().toISOString();
      this.#dirty = false;
      this.#status = summarizeStatus(this.#files, lastIndexedAt, Date.now() - startedAt, this.#truncated);
      if (changed) await this.#persist(lastIndexedAt);
      return this.status();
    } catch (error) {
      this.#dirty = true;
      this.#status = {
        ...this.#status,
        state: "failed",
        scanDurationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      return this.status();
    }
  }

  #rebuildLookups(): void {
    this.#references.clear();
    this.#dependents.clear();
    for (const file of this.#files.values()) {
      for (const reference of file.references) {
        const key = referenceKey(reference.name);
        const list = this.#references.get(key) ?? [];
        list.push(reference);
        this.#references.set(key, list);
      }
      for (const dependency of file.dependencies) {
        const dependents = this.#dependents.get(dependency) ?? new Set<string>();
        dependents.add(file.path);
        this.#dependents.set(dependency, dependents);
      }
    }
    for (const references of this.#references.values()) {
      references.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
    }
  }

  #applyGlobalLimits(): {
    symbols: number;
    references: number;
    dependencies: number;
    truncated: boolean;
  } {
    const totals = { symbols: 0, references: 0, dependencies: 0, truncated: false };
    for (const [filePath, file] of this.#files) {
      const limited = limitIndexedFile(file, {
        symbols: MAX_INDEX_SYMBOLS - totals.symbols,
        references: MAX_INDEX_REFERENCES - totals.references,
        dependencies: MAX_INDEX_DEPENDENCIES - totals.dependencies,
      });
      if (limited.file !== file) this.#files.set(filePath, limited.file);
      totals.symbols += limited.file.symbols.length;
      totals.references += limited.file.references.length;
      totals.dependencies += limited.file.dependencies.length;
      totals.truncated ||= limited.truncated;
    }
    return totals;
  }

  async #loadCache(): Promise<void> {
    try {
      if ((await stat(this.cachePath)).size > MAX_INDEX_CACHE_BYTES) return;
      const raw = JSON.parse(await readFile(this.cachePath, "utf8")) as PersistedIndex;
      if (raw.version !== INDEX_VERSION || typeof raw.lastIndexedAt !== "string" || !Array.isArray(raw.files)) return;
      for (const file of raw.files.slice(0, MAX_INDEX_FILES)) {
        if (!isPersistedFile(file)) continue;
        this.#files.set(file.path, file);
      }
      const totals = this.#applyGlobalLimits();
      this.#truncated = totals.truncated;
      this.#rebuildLookups();
      this.#status = summarizeStatus(this.#files, raw.lastIndexedAt, 0, this.#truncated);
    } catch {
      // A missing or corrupt cache is rebuilt from project sources.
    }
  }

  async #persist(lastIndexedAt: string): Promise<void> {
    const directory = path.dirname(this.cachePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      lastIndexedAt,
      files: [...this.#files.values()],
    };
    await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await rename(temporaryPath, this.cachePath);
  }

  #startWatcher(): void {
    if (this.#watcher || this.#disposed) return;
    try {
      this.#watcher = watch(this.workspaceRoot, { recursive: true }, (_event, filename) => {
        const relative = String(filename ?? "").replace(/\\/gu, "/");
        if (!isIndexableRelativePath(relative)) return;
        this.#dirty = true;
        if (this.#watchTimer) clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => {
          this.#watchTimer = undefined;
          void this.refresh();
        }, 500);
      });
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      // Queries still perform an incremental stat scan on demand when watching is unavailable.
    }
  }
}

interface CandidateFile {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

async function collectIndexCandidates(workspaceRoot: string): Promise<CandidateFile[]> {
  const result: CandidateFile[] = [];
  let totalBytes = 0;
  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= MAX_INDEX_FILES || totalBytes >= MAX_TOTAL_SOURCE_BYTES) return;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const normalized = relativePath.replace(/\\/gu, "/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(normalized, entry.name)) continue;
        await visit(path.join(absoluteDirectory, entry.name), normalized);
        continue;
      }
      if (!entry.isFile() || !isIndexableRelativePath(normalized)) continue;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const metadata = await stat(absolutePath);
      if (metadata.size > MAX_SOURCE_FILE_BYTES || totalBytes + metadata.size > MAX_TOTAL_SOURCE_BYTES) continue;
      result.push({ path: normalized, absolutePath, size: metadata.size, mtimeMs: metadata.mtimeMs });
      totalBytes += metadata.size;
    }
  };
  await visit(workspaceRoot, "");
  return result;
}

function shouldIgnoreDirectory(relativePath: string, name: string): boolean {
  if (IGNORED_DIRECTORIES.has(name)) return true;
  const lower = relativePath.toLowerCase();
  return lower === "addons/godetx" || lower.startsWith("addons/godetx/");
}

function isIndexableRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\0")) return false;
  const normalized = relativePath.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) return false;
  if (normalized.toLowerCase().startsWith("addons/godetx/")) return false;
  if (normalized === "project.godot") return true;
  return INDEXED_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function parseIndexedFile(filePath: string, size: number, mtimeMs: number, content: string): IndexedFile {
  const extension = path.posix.extname(filePath).toLowerCase();
  const parsed = extension === ".gd"
    ? parseGdScript(filePath, content)
    : extension === ".gdshader"
      ? parseShader(filePath, content)
      : extension === ".tscn" || extension === ".tres"
        ? parseTextResource(filePath, content)
        : parseProjectSettings(filePath, content);
  return {
    path: filePath,
    size,
    mtimeMs,
    kind: extensionKind(filePath),
    symbols: parsed.symbols,
    references: parsed.references.slice(0, MAX_REFERENCES_PER_FILE),
    dependencies: [...new Set(parsed.dependencies)].sort(),
  };
}

function limitIndexedFile(
  file: IndexedFile,
  remaining: { symbols: number; references: number; dependencies: number },
): { file: IndexedFile; truncated: boolean } {
  const symbolLimit = Math.max(0, remaining.symbols);
  const referenceLimit = Math.max(0, remaining.references);
  const dependencyLimit = Math.max(0, remaining.dependencies);
  const truncated = file.symbols.length > symbolLimit
    || file.references.length > referenceLimit
    || file.dependencies.length > dependencyLimit;
  if (!truncated) return { file, truncated: false };
  return {
    file: {
      ...file,
      symbols: file.symbols.slice(0, symbolLimit),
      references: file.references.slice(0, referenceLimit),
      dependencies: file.dependencies.slice(0, dependencyLimit),
    },
    truncated: true,
  };
}

interface ParsedSemanticFile {
  symbols: SemanticSymbol[];
  references: SemanticReference[];
  dependencies: string[];
}

function parseGdScript(filePath: string, content: string): ParsedSemanticFile {
  const symbols: SemanticSymbol[] = [];
  const dependencies: string[] = [];
  const lines = content.split(/\r?\n/u);
  let extendsDetail = "";
  for (let index = 0; index < lines.length; index += 1) {
    const source = stripGdComment(lines[index]!);
    const line = index + 1;
    addMatchSymbol(symbols, filePath, source, line, /^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/u, "class");
    addMatchSymbol(symbols, filePath, source, line, /^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)/u, "method");
    addMatchSymbol(symbols, filePath, source, line, /^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)/u, "signal");
    addMatchSymbol(symbols, filePath, source, line, /^\s*(?:(?:@export[^\s]*)|@onready|static)\s+var\s+([A-Za-z_][A-Za-z0-9_]*)/u, "variable");
    addMatchSymbol(symbols, filePath, source, line, /^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)/u, "variable");
    addMatchSymbol(symbols, filePath, source, line, /^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)/u, "constant");
    addMatchSymbol(symbols, filePath, source, line, /^\s*enum(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/u, "enum", "<anonymous>");
    const extendsMatch = /^\s*extends\s+(.+?)\s*$/u.exec(source);
    if (extendsMatch) extendsDetail = `extends ${extendsMatch[1]!.trim()}`;
    collectResourcePaths(source, dependencies);
  }
  const classSymbol = symbols.find((symbol) => symbol.kind === "class");
  if (classSymbol && extendsDetail) classSymbol.detail = extendsDetail;
  return {
    symbols,
    references: collectReferences(filePath, content, symbols),
    dependencies,
  };
}

function parseShader(filePath: string, content: string): ParsedSemanticFile {
  const symbols: SemanticSymbol[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!.replace(/\/\/.*$/u, "");
    const line = index + 1;
    const shaderType = /^\s*shader_type\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(source);
    if (shaderType) symbols.push(makeSymbol(filePath, source, line, shaderType[1]!, "shader", `shader_type ${shaderType[1]}`));
    addMatchSymbol(symbols, filePath, source, line, /^\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^;=]+)?\s+([A-Za-z_][A-Za-z0-9_]*)/u, "uniform");
    addMatchSymbol(symbols, filePath, source, line, /^\s*void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u, "method");
  }
  const dependencies: string[] = [];
  collectResourcePaths(content, dependencies);
  return { symbols, references: collectReferences(filePath, content, symbols), dependencies };
}

function parseTextResource(filePath: string, content: string): ParsedSemanticFile {
  const symbols: SemanticSymbol[] = [];
  const dependencies: string[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    const line = index + 1;
    const nodeMatch = /^\[node\s+name="([^"]+)"([^\]]*)\]/u.exec(source);
    if (nodeMatch) {
      const parentMatch = /\bparent="([^"]*)"/u.exec(nodeMatch[2]!);
      const parentPath = parentMatch?.[1] ?? "";
      const nodePath = !parentMatch
        ? "."
        : parentPath === "."
          ? nodeMatch[1]!
          : `${parentPath}/${nodeMatch[1]}`;
      const typeMatch = /\btype="([^"]+)"/u.exec(nodeMatch[2]!);
      const detail = [
        `node ${nodeMatch[1]}`,
        ...(typeMatch ? [`type ${typeMatch[1]}`] : []),
      ].join("; ");
      symbols.push(makeSymbol(filePath, source, line, nodePath, "scene_node", detail));
    }
    const resourceHeader = /^\[(?:gd_resource|sub_resource)\b([^\]]*)\]/u.exec(source);
    if (resourceHeader) {
      const typeMatch = /\btype="([^"]+)"/u.exec(resourceHeader[1]!);
      const idMatch = /\bid="([^"]+)"/u.exec(resourceHeader[1]!);
      const name = idMatch?.[1] ?? typeMatch?.[1] ?? path.posix.basename(filePath);
      symbols.push(makeSymbol(filePath, source, line, name, "resource", typeMatch ? `type ${typeMatch[1]}` : undefined));
    }
    const connectionMatch = /^\[connection\b([^\]]*)\]/u.exec(source);
    if (connectionMatch) {
      const methodMatch = /\bmethod="([^"]+)"/u.exec(connectionMatch[1]!);
      if (methodMatch) symbols.push(makeSymbol(filePath, source, line, methodMatch[1]!, "method", "scene signal handler"));
    }
    collectResourcePaths(source, dependencies);
  }
  return { symbols, references: collectReferences(filePath, content, symbols), dependencies };
}

function parseProjectSettings(filePath: string, content: string): ParsedSemanticFile {
  const symbols: SemanticSymbol[] = [];
  const dependencies: string[] = [];
  const lines = content.split(/\r?\n/u);
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    const line = index + 1;
    const sectionMatch = /^\[([^\]]+)\]/u.exec(source);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      symbols.push(makeSymbol(filePath, source, line, section, "section"));
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_./-]+)\s*=/u.exec(source);
    if (keyMatch && section === "autoload") symbols.push(makeSymbol(filePath, source, line, keyMatch[1]!, "autoload"));
    if (keyMatch && section === "input") symbols.push(makeSymbol(filePath, source, line, keyMatch[1]!, "input_action"));
    collectResourcePaths(source, dependencies);
  }
  return { symbols, references: collectReferences(filePath, content, symbols), dependencies };
}

function collectReferences(filePath: string, content: string, symbols: readonly SemanticSymbol[]): SemanticReference[] {
  const definitions = new Set(symbols.map((symbol) => `${symbol.line}:${symbol.column}:${symbol.name}`));
  const references: SemanticReference[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length && references.length < MAX_REFERENCES_PER_FILE; index += 1) {
    const source = lines[index]!;
    for (const match of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/gu)) {
      if (references.length >= MAX_REFERENCES_PER_FILE) break;
      const name = match[0];
      if (GDSCRIPT_KEYWORDS.has(name)) continue;
      const column = (match.index ?? 0) + 1;
      references.push({
        name,
        path: filePath,
        line: index + 1,
        column,
        kind: "identifier",
        ...(definitions.has(`${index + 1}:${column}:${name}`) ? { definition: true } : {}),
      });
    }
    for (const match of source.matchAll(/res:\/\/[A-Za-z0-9_@.\/\-]+/gu)) {
      if (references.length >= MAX_REFERENCES_PER_FILE) break;
      references.push({ name: match[0], path: filePath, line: index + 1, column: (match.index ?? 0) + 1, kind: "resource_path" });
    }
    for (const match of source.matchAll(/[$%]([A-Za-z_][A-Za-z0-9_\/]*)/gu)) {
      if (references.length >= MAX_REFERENCES_PER_FILE) break;
      references.push({ name: match[1]!, path: filePath, line: index + 1, column: (match.index ?? 0) + 2, kind: "node_path" });
    }
  }
  return references;
}

function addMatchSymbol(
  symbols: SemanticSymbol[],
  filePath: string,
  source: string,
  line: number,
  pattern: RegExp,
  kind: SemanticSymbolKind,
  fallbackName?: string,
): void {
  const match = pattern.exec(source);
  if (!match) return;
  const name = match[1] || fallbackName;
  if (!name) return;
  symbols.push(makeSymbol(filePath, source, line, name, kind));
}

function makeSymbol(
  filePath: string,
  source: string,
  line: number,
  name: string,
  kind: SemanticSymbolKind,
  detail?: string,
): SemanticSymbol {
  return {
    name,
    kind,
    path: filePath,
    line,
    column: Math.max(1, source.indexOf(name) + 1),
    ...(detail ? { detail } : {}),
  };
}

function collectResourcePaths(source: string, dependencies: string[]): void {
  for (const match of source.matchAll(/res:\/\/[A-Za-z0-9_@.\/\-]+/gu)) {
    try {
      dependencies.push(normalizeProjectPath(match[0]));
    } catch {
      // Ignore malformed paths embedded in source text.
    }
  }
}

function stripGdComment(source: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? "" : character;
      continue;
    }
    if (character === "#" && !quote) return source.slice(0, index);
  }
  return source;
}

function normalizeProjectPath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^res:\/\//iu, "").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) throw new Error("path must be a project-relative resource path");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("path must stay inside the project");
  return parts.join("/");
}

function normalizeOptionalPrefix(value: string | undefined): string {
  return value ? normalizeProjectPath(value).toLowerCase() : "";
}

function normalizeQuery(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${field} must be a non-empty safe string of at most ${maxLength} characters`);
  }
  return normalized;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_RESULTS) throw new Error(`limit must be an integer from 1 to ${MAX_QUERY_RESULTS}`);
  return value;
}

function referenceKey(value: string): string {
  return value.startsWith("res://") ? value.toLowerCase() : value;
}

function extensionKind(filePath: string): string {
  if (filePath === "project.godot") return "project_settings";
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".gd": return "gdscript";
    case ".gdshader": return "shader";
    case ".tscn": return "scene";
    case ".tres": return "resource";
    default: return "unknown";
  }
}

function summarizeStatus(
  files: ReadonlyMap<string, IndexedFile>,
  lastIndexedAt: string,
  scanDurationMs: number,
  truncated: boolean,
): ProjectIndexStatus {
  let symbolCount = 0;
  let referenceCount = 0;
  let dependencyCount = 0;
  for (const file of files.values()) {
    symbolCount += file.symbols.length;
    referenceCount += file.references.length;
    dependencyCount += file.dependencies.length;
  }
  return {
    state: "ready",
    fileCount: files.size,
    symbolCount,
    referenceCount,
    dependencyCount,
    lastIndexedAt,
    scanDurationMs,
    truncated,
  };
}

function isPersistedFile(value: unknown): value is IndexedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Partial<IndexedFile>;
  return typeof file.path === "string"
    && isIndexableRelativePath(file.path)
    && normalizePersistedPath(file.path) === file.path
    && typeof file.size === "number"
    && Number.isFinite(file.size)
    && file.size >= 0
    && file.size <= MAX_SOURCE_FILE_BYTES
    && typeof file.mtimeMs === "number"
    && Number.isFinite(file.mtimeMs)
    && file.mtimeMs >= 0
    && typeof file.kind === "string"
    && Array.isArray(file.symbols)
    && file.symbols.length <= MAX_INDEX_SYMBOLS
    && file.symbols.every((symbol) => isPersistedSymbol(symbol, file.path!))
    && Array.isArray(file.references)
    && file.references.length <= MAX_REFERENCES_PER_FILE
    && file.references.every((reference) => isPersistedReference(reference, file.path!))
    && Array.isArray(file.dependencies)
    && file.dependencies.length <= MAX_INDEX_DEPENDENCIES
    && file.dependencies.every((dependency) => (
      typeof dependency === "string" && normalizePersistedPath(dependency) === dependency
    ));
}

function isPersistedSymbol(value: unknown, filePath: string): value is SemanticSymbol {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const symbol = value as Partial<SemanticSymbol>;
  return typeof symbol.name === "string"
    && symbol.name.length > 0
    && symbol.name.length <= 1024
    && typeof symbol.kind === "string"
    && SEMANTIC_SYMBOL_KINDS.has(symbol.kind)
    && symbol.path === filePath
    && isPositiveSafeInteger(symbol.line)
    && isPositiveSafeInteger(symbol.column)
    && (symbol.detail === undefined || (typeof symbol.detail === "string" && symbol.detail.length <= 4096));
}

function isPersistedReference(value: unknown, filePath: string): value is SemanticReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<SemanticReference>;
  return typeof reference.name === "string"
    && reference.name.length > 0
    && reference.name.length <= 1024
    && reference.path === filePath
    && isPositiveSafeInteger(reference.line)
    && isPositiveSafeInteger(reference.column)
    && (reference.kind === "identifier" || reference.kind === "resource_path" || reference.kind === "node_path")
    && (reference.definition === undefined || typeof reference.definition === "boolean");
}

function normalizePersistedPath(value: string): string {
  try {
    return normalizeProjectPath(value);
  } catch {
    return "";
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
