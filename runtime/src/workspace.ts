import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

export type PatchOperation =
  | { action: "replace"; path: string; old_text: string; new_text: string; replace_all?: boolean }
  | { action: "create"; path: string; content: string }
  | { action: "delete"; path: string };

export interface PreparedFileChange {
  path: string;
  absolutePath: string;
  kind: "create" | "update" | "delete";
  oldContent: string | null;
  newContent: string | null;
  baseHash: string | null;
  diff: string;
}

export interface PreparedTransaction {
  id: string;
  changes: PreparedFileChange[];
  diff: string;
}

export interface WorkspaceFileIdentity {
  realPath: string;
  fileId?: string;
}

const SKIP_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".git",
  ".godot",
  ".godetx",
  ".pytest_cache",
  ".tmp",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "venv",
]);
const PROTECTED_SEGMENTS = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".git",
  ".godot",
  ".godetx",
  ".godetx_test",
  ".tmp",
  "node_modules",
]);
const PROTECTED_NAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
]);

export class Workspace {
  readonly root: string;
  readonly #rootReal: string;
  readonly #writeAllowlist: Set<string> | undefined;

  private constructor(root: string, rootReal: string, writeAllowlist?: string[]) {
    this.root = root;
    this.#rootReal = rootReal;
    this.#writeAllowlist = writeAllowlist
      ? new Set(writeAllowlist.map((entry) => normalizeRelative(entry)))
      : undefined;
  }

  static async open(root: string, writeAllowlist?: string[]): Promise<Workspace> {
    const absolute = path.resolve(root);
    const info = await stat(absolute);
    if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${absolute}`);
    return new Workspace(absolute, await realpath(absolute), writeAllowlist);
  }

  async listFiles(limit = 500, fileSuffix?: string): Promise<string[]> {
    const files: string[] = [];
    const directories = [this.root];
    const normalizedSuffix = fileSuffix?.toLowerCase();
    for (let directoryIndex = 0; directoryIndex < directories.length && files.length < limit; directoryIndex += 1) {
      const directory = directories[directoryIndex]!;
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isSkippableDirectoryError(error)) continue;
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(absolute);
        else if (entry.isFile()) {
          const relative = toPosix(path.relative(this.root, absolute));
          if (this.#isProtected(relative)) continue;
          if (normalizedSuffix && !relative.toLowerCase().endsWith(normalizedSuffix)) continue;
          files.push(relative);
        }
      }
    }
    return files;
  }

  async readText(relativePath: string, maxBytes = 512_000): Promise<string> {
    this.#assertReadable(normalizeRelative(relativePath));
    const absolute = await this.#resolveSafe(relativePath, false);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Not a file: ${relativePath}`);
    if (info.size > maxBytes) throw new Error(`File is too large (${info.size} bytes): ${relativePath}`);
    return readFile(absolute, "utf8");
  }

  async writeBinary(relativePath: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const relative = normalizeRelative(relativePath);
    this.#assertWritable(relative);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error("Binary file content must not be empty");
    }
    signal?.throwIfAborted();
    const absolute = await this.#resolveSafe(relative, true);
    signal?.throwIfAborted();
    await mkdir(path.dirname(absolute), { recursive: true });
    signal?.throwIfAborted();
    const file = await open(absolute, "wx");
    try {
      signal?.throwIfAborted();
      await file.writeFile(bytes);
      signal?.throwIfAborted();
      await file.sync();
      signal?.throwIfAborted();
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
    await file.close();
    return relative;
  }

  async search(query: string, globSuffix?: string, limit = 100): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!query) throw new Error("Search query must not be empty");
    const results: Array<{ path: string; line: number; text: string }> = [];
    const files = await this.listFiles(2_000, globSuffix);
    for (const file of files) {
      let content: string;
      try {
        content = await this.readText(file, 256_000);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.includes(query)) continue;
        results.push({ path: file, line: index + 1, text: line.slice(0, 500) });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async fileIdentity(relativePath: string): Promise<WorkspaceFileIdentity | undefined> {
    const relative = normalizeRelative(relativePath);
    const absolute = path.resolve(this.root, ...relative.split("/"));
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (absolute !== this.root && !absolute.startsWith(rootPrefix)) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
    const realPrefix = this.#rootReal.endsWith(path.sep) ? this.#rootReal : `${this.#rootReal}${path.sep}`;
    if (resolved !== this.#rootReal && !resolved.startsWith(realPrefix)) {
      throw new Error(`Path resolves outside workspace: ${relativePath}`);
    }
    const info = await stat(resolved);
    if (!info.isFile()) return undefined;
    const realPath = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return {
      realPath,
      ...(info.ino !== 0 ? { fileId: `${info.dev}:${info.ino}` } : {}),
    };
  }

  async preparePatch(operations: PatchOperation[]): Promise<PreparedTransaction> {
    if (operations.length === 0) throw new Error("Patch must contain at least one operation");
    const grouped = new Map<string, PatchOperation[]>();
    const changes: PreparedFileChange[] = [];

    for (const operation of operations) {
      const relative = normalizeRelative(operation.path);
      this.#assertWritable(relative);
      const group = grouped.get(relative) ?? [];
      group.push(operation);
      grouped.set(relative, group);
    }

    for (const [relative, fileOperations] of grouped) {
      const first = fileOperations[0]!;
      const absolute = await this.#resolveSafe(relative, first.action === "create");
      const oldContent = await readOptional(absolute);
      let newContent = oldContent;

      for (const operation of fileOperations) {
        if (operation.action === "create") {
          if (newContent !== null) throw new Error(`File already exists: ${relative}`);
          newContent = operation.content;
        } else if (operation.action === "delete") {
          if (newContent === null) throw new Error(`File does not exist: ${relative}`);
          newContent = null;
        } else {
          if (newContent === null) throw new Error(`File does not exist: ${relative}`);
          if (!operation.old_text) throw new Error(`old_text must not be empty: ${relative}`);
          const occurrences = countOccurrences(newContent, operation.old_text);
          if (occurrences === 0) throw new Error(`old_text was not found in ${relative}`);
          if (!operation.replace_all && occurrences !== 1) {
            throw new Error(`old_text occurs ${occurrences} times in ${relative}; make it unique or set replace_all`);
          }
          newContent = operation.replace_all
            ? newContent.replaceAll(operation.old_text, operation.new_text)
            : newContent.replace(operation.old_text, operation.new_text);
        }
      }

      if (oldContent === newContent) throw new Error(`Patch does not change ${relative}`);
      const kind: PreparedFileChange["kind"] =
        oldContent === null ? "create" : newContent === null ? "delete" : "update";
      changes.push({
        path: relative,
        absolutePath: absolute,
        kind,
        oldContent,
        newContent,
        baseHash: oldContent === null ? null : hash(oldContent),
        diff: createTwoFilesPatch(
          `a/${relative}`,
          `b/${relative}`,
          oldContent ?? "",
          newContent ?? "",
          "before",
          "after",
          { context: 3 },
        ),
      });
    }

    return {
      id: randomUUID(),
      changes,
      diff: changes.map((change) => change.diff).join("\n"),
    };
  }

  async apply(transaction: PreparedTransaction): Promise<string[]> {
    for (const change of transaction.changes) {
      const resolved = await this.#resolveSafe(change.path, change.baseHash === null);
      if (resolved !== change.absolutePath) throw new Error(`Path changed after preview: ${change.path}`);
      const current = await readOptional(change.absolutePath);
      const currentHash = current === null ? null : hash(current);
      if (currentHash !== change.baseHash) {
        throw new Error(`File changed after preview; refusing stale patch: ${change.path}`);
      }
    }

    const applied: PreparedFileChange[] = [];
    try {
      for (const change of transaction.changes) {
        const resolved = await this.#resolveSafe(change.path, change.baseHash === null);
        if (resolved !== change.absolutePath) throw new Error(`Path changed before write: ${change.path}`);
        if (change.newContent === null) {
          await rm(change.absolutePath);
        } else {
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          await writeFile(change.absolutePath, change.newContent, "utf8");
        }
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        if (change.oldContent === null) await rm(change.absolutePath, { force: true });
        else {
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          await writeFile(change.absolutePath, change.oldContent, "utf8");
        }
      }
      throw error;
    }
    return transaction.changes.map((change) => change.path);
  }

  async #resolveSafe(relativePath: string, allowMissing: boolean): Promise<string> {
    const relative = normalizeRelative(relativePath);
    const absolute = path.resolve(this.root, ...relative.split("/"));
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (absolute !== this.root && !absolute.startsWith(rootPrefix)) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }

    let cursor = absolute;
    while (true) {
      try {
        const resolved = await realpath(cursor);
        const realPrefix = this.#rootReal.endsWith(path.sep) ? this.#rootReal : `${this.#rootReal}${path.sep}`;
        if (resolved !== this.#rootReal && !resolved.startsWith(realPrefix)) {
          throw new Error(`Path resolves outside workspace: ${relativePath}`);
        }
        break;
      } catch (error) {
        if (isOutsideError(error)) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    if (!allowMissing && (await readOptional(absolute)) === null) throw new Error(`File does not exist: ${relative}`);
    return absolute;
  }

  #assertWritable(relative: string): void {
    if (this.#isProtected(relative)) {
      throw new Error(`Protected path cannot be modified: ${relative}`);
    }
    if (this.#writeAllowlist && !this.#writeAllowlist.has(relative)) {
      throw new Error(`Path is outside this turn's write allowlist: ${relative}`);
    }
  }

  #assertReadable(relative: string): void {
    if (this.#isProtected(relative)) throw new Error(`Protected path cannot be read: ${relative}`);
  }

  #isProtected(relative: string): boolean {
    const segments = relative.split("/");
    if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))) return true;
    const basename = segments.at(-1)?.toLowerCase() ?? "";
    if (
      PROTECTED_NAMES.has(basename) ||
      basename.startsWith(".env.") ||
      basename.endsWith(".pem") ||
      basename.endsWith(".key")
    ) {
      return true;
    }
    return false;
  }
}

export function normalizeRelative(input: string): string {
  if (!input || input.includes("\0")) throw new Error("Path must not be empty");
  const portable = input.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) {
    throw new Error(`Absolute paths are not allowed: ${input}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return normalized;
}

async function readOptional(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosix(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function isOutsideError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Path resolves outside workspace");
}

function isSkippableDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
