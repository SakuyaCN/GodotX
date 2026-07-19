import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseImageAnnotations, type ImageAnnotation } from "./image-annotations.js";
import type { AgentMessage, ContentPart, ImageDetail, ProviderUsage } from "./provider/types.js";

export const SESSION_STORE_SCHEMA_VERSION = 3 as const;
const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STORED_TURNS = 100;
const MAX_TURN_ENTRIES = 512;
const MAX_MESSAGE_TEXT = 200_000;
const MAX_TOOL_TEXT = 64_000;
const MAX_REASONING_TEXT = 32_000;
const MAX_TITLE_LENGTH = 120;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ITEMS = 512;

export type PersistedTurnStatus = "running" | "completed" | "interrupted" | "failed";
export type PersistedProviderFailureCode = "PROVIDER_AUTH_FAILED" | "PROVIDER_BILLING_FAILED";

export interface PersistedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PersistedContextStats {
  historyCharacters: number;
  contextCharacters: number;
  droppedMessages: number;
  compactedToolMessages: number;
  compacted: boolean;
}

export interface PersistedAttachmentReference {
  attachmentId: string;
  mimeType: Extract<ContentPart, { type: "image" }>["mimeType"];
  detail: ImageDetail;
  annotations?: ImageAnnotation[];
  annotatedFrom?: string;
  byteSize: number;
  width: number;
  height: number;
  source?: "file" | "clipboard" | "project_resource" | "editor_viewport" | "game_frame";
  name?: string;
  runId?: string;
  sceneId?: string;
  scenePath?: string;
  capturedAtMs?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  frame?: number;
}

export type PersistedTurnEntry =
  | {
      kind: "context";
      itemId: string;
      data: unknown;
    }
  | {
      kind: "assistant";
      itemId: string;
      text: string;
      reasoning: string;
    }
  | {
      kind: "tool";
      itemId: string;
      name: string;
      arguments: unknown;
      output: unknown;
    };

export interface PersistedTurn {
  id: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  status: PersistedTurnStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  errorCode?: PersistedProviderFailureCode;
  errorStatus?: number;
  messageStartIndex?: number;
  context?: PersistedContextStats;
  attachments?: PersistedAttachmentReference[];
  usage: PersistedUsage;
  entries: PersistedTurnEntry[];
}

export interface PersistedSession {
  schemaVersion: typeof SESSION_STORE_SCHEMA_VERSION;
  revision: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  extraSystemPrompt?: string;
  messages: AgentMessage[];
  turns: PersistedTurn[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastStatus?: Exclude<PersistedTurnStatus, "running">;
  usage: PersistedUsage;
}

export type SessionStoreDiagnosticCode = "corrupt" | "too_large" | "unreadable" | "recovery_write_failed";

export interface SessionStoreDiagnostic {
  filename: string;
  code: SessionStoreDiagnosticCode;
}

export class SessionStore {
  readonly #directory: string;
  readonly #activeTurns = new Map<string, string>();
  readonly #diagnostics = new Map<string, SessionStoreDiagnosticCode>();

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
  }

  static forWorkspace(workspace: string, dataDirectory?: string): SessionStore {
    const resolvedWorkspace = path.resolve(workspace);
    const directory = dataDirectory
      ? path.join(
          path.resolve(dataDirectory),
          "godetx",
          "sessions",
          createHash("sha256").update(normalizeWorkspaceIdentity(resolvedWorkspace)).digest("hex").slice(0, 24),
        )
      : path.join(resolvedWorkspace, ".godot", "godetx", "sessions");
    return new SessionStore(directory);
  }

  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    const filenames = readdirSync(this.#directory);
    const snapshotFiles = new Set(filenames.filter((filename) => filename.endsWith(".json")));
    for (const filename of this.#diagnostics.keys()) {
      if (!snapshotFiles.has(filename)) this.#diagnostics.delete(filename);
    }
    for (const filename of filenames) {
      if (!filename.endsWith(".json")) continue;
      const session = this.#loadFile(filename);
      if (session) sessions.push(session);
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  load(sessionId: string): PersistedSession | undefined {
    const filepath = this.#sessionPath(sessionId);
    if (!existsSync(filepath)) {
      this.#diagnostics.delete(`${sessionId}.json`);
      return undefined;
    }
    return this.#loadFile(`${sessionId}.json`);
  }

  listDiagnostics(): SessionStoreDiagnostic[] {
    return [...this.#diagnostics.entries()]
      .map(([filename, code]) => ({ filename, code }))
      .sort((left, right) => left.filename.localeCompare(right.filename));
  }

  save(session: PersistedSession, expectedRevision = session.revision, owner?: string): PersistedSession {
    this.#assertOwnerMayMutate(session.id, owner);
    const normalized = prepareSessionForStorage(session);
    const target = this.#sessionPath(normalized.id);
    const currentRevision = this.#readRevision(target);
    if (currentRevision !== expectedRevision) {
      throw new SessionConflictError(normalized.id);
    }
    normalized.revision = currentRevision + 1;
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let serialized = `${JSON.stringify(normalized)}\n`;
    while (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_FILE_BYTES && normalized.turns.length > 1) {
      normalized.turns.shift();
      serialized = `${JSON.stringify(normalized)}\n`;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_FILE_BYTES) {
      normalized.turns = normalized.turns.map(compactTurnForStorage);
      serialized = `${JSON.stringify(normalized)}\n`;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session ${normalized.id} exceeds the ${MAX_SESSION_FILE_BYTES} byte persistence limit`);
    }

    try {
      writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      const descriptor = openSync(temporary, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.#diagnostics.delete(`${normalized.id}.json`);
    return normalized;
  }

  delete(sessionId: string, expectedRevision?: number, owner?: string): boolean {
    this.#assertOwnerMayMutate(sessionId, owner);
    const target = this.#sessionPath(sessionId);
    const currentRevision = this.#readRevision(target);
    if (currentRevision === 0) {
      if (expectedRevision !== undefined && expectedRevision !== 0) throw new SessionConflictError(sessionId);
      return false;
    }
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
      throw new SessionConflictError(sessionId);
    }
    unlinkSync(target);
    this.#diagnostics.delete(`${sessionId}.json`);
    return true;
  }

  claimTurn(sessionId: string, owner: string): void {
    if (!isSessionId(sessionId) || !owner) throw new Error("Invalid session turn owner");
    const currentOwner = this.#activeTurns.get(sessionId);
    if (currentOwner && currentOwner !== owner) {
      throw new SessionConflictError(sessionId, "Conversation already has an active turn in another connection");
    }
    this.#activeTurns.set(sessionId, owner);
  }

  releaseTurn(sessionId: string, owner: string): void {
    if (this.#activeTurns.get(sessionId) === owner) this.#activeTurns.delete(sessionId);
  }

  #assertOwnerMayMutate(sessionId: string, owner: string | undefined): void {
    const activeOwner = this.#activeTurns.get(sessionId);
    if (activeOwner && activeOwner !== owner) {
      throw new SessionConflictError(sessionId, "Conversation is active in another connection");
    }
  }

  #loadFile(filename: string): PersistedSession | undefined {
    const filepath = path.join(this.#directory, filename);
    let parsed: unknown;
    try {
      if (statSync(filepath).size > MAX_SESSION_FILE_BYTES) {
        this.#diagnostics.set(filename, "too_large");
        return undefined;
      }
      parsed = JSON.parse(readFileSync(filepath, "utf8")) as unknown;
    } catch (error) {
      this.#diagnostics.set(filename, error instanceof SyntaxError ? "corrupt" : "unreadable");
      return undefined;
    }
    const session = parsePersistedSession(parsed);
    if (!session || filename !== `${session.id}.json`) {
      this.#diagnostics.set(filename, "corrupt");
      return undefined;
    }
    const legacySnapshot = isRecord(parsed) && parsed.schemaVersion !== SESSION_STORE_SCHEMA_VERSION;
    let checkpointNeeded = legacySnapshot && !this.#activeTurns.has(session.id);
    const repairedTurnIds = new Set<string>();
    const recoveredAt = new Date().toISOString();
    for (const turn of session.turns) {
      if (turn.status !== "running") continue;
      if (this.#activeTurns.has(session.id)) continue;
      session.messages = repairIncompleteTurnTranscript(session.messages, turn, "interrupted");
      turn.status = "interrupted";
      turn.completedAt = recoveredAt;
      repairedTurnIds.add(turn.id);
      checkpointNeeded = true;
    }
    const lastTurn = session.turns.at(-1);
    if (
      legacySnapshot &&
      lastTurn &&
      !repairedTurnIds.has(lastTurn.id) &&
      (lastTurn.status === "interrupted" || lastTurn.status === "failed") &&
      !this.#activeTurns.has(session.id)
    ) {
      session.messages = repairIncompleteTurnTranscript(session.messages, lastTurn, lastTurn.status);
      checkpointNeeded = true;
    }
    if (checkpointNeeded) {
      if (repairedTurnIds.size > 0) session.updatedAt = recoveredAt;
      try {
        const saved = this.save(session, session.revision);
        session.revision = saved.revision;
      } catch {
        this.#diagnostics.set(filename, "recovery_write_failed");
        return session;
      }
    }
    this.#diagnostics.delete(filename);
    return session;
  }

  #readRevision(filepath: string): number {
    if (!existsSync(filepath)) return 0;
    try {
      if (statSync(filepath).size > MAX_SESSION_FILE_BYTES) throw new Error("Session snapshot is too large");
      const parsed = JSON.parse(readFileSync(filepath, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("Session snapshot is invalid");
      return readRevision(parsed.revision);
    } catch (error) {
      throw new Error(`Could not read the current session revision: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #sessionPath(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error("Invalid session ID");
    return path.join(this.#directory, `${sessionId}.json`);
  }
}

export class SessionConflictError extends Error {
  readonly code = "SESSION_CONFLICT";

  constructor(sessionId: string, message = "Conversation changed in another connection; reload it and try again") {
    super(`${message}: ${sessionId}`);
    this.name = "SessionConflictError";
  }
}

export function repairIncompleteTurnTranscript(
  messages: readonly AgentMessage[],
  turn: PersistedTurn,
  status: "failed" | "interrupted",
): AgentMessage[] {
  const start = resolveTurnMessageStart(messages, turn);
  const prefix = messages.slice(0, start).map(cloneAgentMessage);
  const candidate = messages.slice(start);
  const retained: AgentMessage[] = [];
  let index = 0;
  if (candidate[0]?.role === "user") {
    retained.push(cloneAgentMessage(candidate[0]));
    index = 1;
  }
  while (index < candidate.length) {
    const message = candidate[index];
    if (!message || message.role !== "assistant") break;
    if (message.toolCalls.length === 0) {
      retained.push(cloneAgentMessage(message));
      index += 1;
      continue;
    }
    const outputs: Extract<AgentMessage, { role: "tool" }>[] = [];
    let outputIndex = index + 1;
    while (candidate[outputIndex]?.role === "tool") {
      outputs.push(cloneAgentMessage(candidate[outputIndex]!) as Extract<AgentMessage, { role: "tool" }>);
      outputIndex += 1;
    }
    const outputById = new Map(outputs.map((output) => [output.callId, output]));
    const hadMissingOutputs = message.toolCalls.some((call) => !outputById.has(call.id));
    const repairedOutputs = message.toolCalls.map((call): Extract<AgentMessage, { role: "tool" }> => {
      const output = outputById.get(call.id);
      if (output) return { ...output, name: call.name };
      return {
        role: "tool",
        callId: call.id,
        name: call.name,
        content: JSON.stringify({
          ok: false,
          error_code: "GODETX_TURN_INTERRUPTED",
          error: "No tool result was recorded. Inspect current project state before retrying this operation.",
        }),
      };
    });
    const observations: Extract<AgentMessage, { role: "user" }>[] = [];
    while (candidate[outputIndex]?.role === "user") {
      const observation = candidate[outputIndex] as Extract<AgentMessage, { role: "user" }>;
      if (!observation.synthetic || !outputById.has(observation.synthetic.callId)) break;
      observations.push(cloneAgentMessage(observation) as Extract<AgentMessage, { role: "user" }>);
      outputIndex += 1;
    }
    retained.push(cloneAgentMessage(message), ...repairedOutputs, ...observations);
    index = outputIndex;
    if (hadMissingOutputs) break;
  }
  if (retained.length > 0) {
    retained.push({
      role: "assistant",
      content: status === "interrupted"
        ? "[GodotX note: this turn was interrupted. Completed tool results above are retained; inspect current project state before continuing.]"
        : "[GodotX note: this turn failed. Completed tool results above are retained; inspect current project state before continuing.]",
      toolCalls: [],
    });
  }
  return [...prefix, ...retained];
}

export function summarizeSession(session: PersistedSession): SessionSummary {
  const lastTurn = session.turns.at(-1);
  const usage: PersistedUsage = {};
  for (const turn of session.turns) addUsage(usage, turn.usage);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    ...(lastTurn && lastTurn.status !== "running" ? { lastStatus: lastTurn.status } : {}),
    usage,
  };
}

export function addUsage(target: PersistedUsage, usage: ProviderUsage | PersistedUsage | undefined): void {
  if (!usage) return;
  if (usage.inputTokens !== undefined) target.inputTokens = (target.inputTokens ?? 0) + usage.inputTokens;
  if (usage.outputTokens !== undefined) target.outputTokens = (target.outputTokens ?? 0) + usage.outputTokens;
  if (usage.totalTokens !== undefined) target.totalTokens = (target.totalTokens ?? 0) + usage.totalTokens;
}

export function makeSessionTitle(prompt: string): string {
  const normalized = redactPersistedText(prompt).replace(/\s+/gu, " ").trim();
  if (!normalized) return "New conversation";
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57).trimEnd()}...`;
}

export function validateSessionTitle(title: string): string {
  const normalized = redactPersistedText(title).replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Session title must not be empty");
  if (normalized.length > MAX_TITLE_LENGTH) throw new Error(`Session title exceeds ${MAX_TITLE_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("Session title contains unsafe characters");
  return normalized;
}

function prepareSessionForStorage(session: PersistedSession): PersistedSession {
  if (!isSessionId(session.id)) throw new Error("Invalid session ID");
  const turns = session.turns.slice(-MAX_STORED_TURNS).map(normalizeTurnForStorage);
  return {
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    revision: readRevision(session.revision),
    id: session.id,
    title: validateSessionTitle(session.title),
    createdAt: readIsoDate(session.createdAt, "createdAt"),
    updatedAt: readIsoDate(session.updatedAt, "updatedAt"),
    ...(session.extraSystemPrompt
      ? { extraSystemPrompt: redactPersistedText(session.extraSystemPrompt).slice(0, MAX_MESSAGE_TEXT) }
      : {}),
    messages: normalizeMessagesForStorage(session.messages),
    turns,
  };
}

function normalizeTurnForStorage(turn: PersistedTurn): PersistedTurn {
  const status = isTurnStatus(turn.status) ? turn.status : "failed";
  const errorStatus = readHttpStatus(turn.errorStatus);
  return {
    id: readSafeId(turn.id, "turn id"),
    prompt: redactPersistedText(turn.prompt).slice(0, MAX_MESSAGE_TEXT),
    model: redactPersistedText(turn.model).slice(0, 256),
    ...(turn.reasoningEffort ? { reasoningEffort: redactPersistedText(turn.reasoningEffort).slice(0, 64) } : {}),
    status,
    startedAt: readIsoDate(turn.startedAt, "startedAt"),
    ...(turn.completedAt ? { completedAt: readIsoDate(turn.completedAt, "completedAt") } : {}),
    ...(turn.error ? { error: redactPersistedText(turn.error).slice(0, 8_000) } : {}),
    ...(isPersistedProviderFailureCode(turn.errorCode) ? { errorCode: turn.errorCode } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(turn.messageStartIndex !== undefined
      ? { messageStartIndex: readNonNegativeInteger(turn.messageStartIndex) ?? 0 }
      : {}),
    ...(turn.context ? { context: normalizeContextStats(turn.context) } : {}),
    ...(turn.attachments ? { attachments: normalizeAttachmentReferences(turn.attachments) } : {}),
    usage: normalizeUsage(turn.usage),
    entries: turn.entries.slice(-MAX_TURN_ENTRIES).flatMap((entry) => {
      const normalized = normalizeEntry(entry);
      return normalized ? [normalized] : [];
    }),
  };
}

function isPersistedProviderFailureCode(value: unknown): value is PersistedProviderFailureCode {
  return value === "PROVIDER_AUTH_FAILED" || value === "PROVIDER_BILLING_FAILED";
}

function readHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function compactTurnForStorage(turn: PersistedTurn): PersistedTurn {
  return {
    ...turn,
    entries: turn.entries.map((entry) => {
      if (entry.kind === "assistant") {
        return { ...entry, reasoning: truncate(entry.reasoning, 4_000), text: truncate(entry.text, 12_000) };
      }
      if (entry.kind === "context") {
        return { ...entry, data: compactUnknown(entry.data, 12_000) };
      }
      return {
        ...entry,
        arguments: compactUnknown(entry.arguments, 4_000),
        output: compactUnknown(entry.output, 8_000),
      };
    }),
  };
}

function parsePersistedSession(value: unknown): PersistedSession | undefined {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== SESSION_STORE_SCHEMA_VERSION)
  ) return undefined;
  if (!isSessionId(value.id)) return undefined;
  if (typeof value.title !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.turns)) return undefined;
  try {
    return prepareSessionForStorage({
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      revision: readRevision(value.revision),
      id: value.id,
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(typeof value.extraSystemPrompt === "string" ? { extraSystemPrompt: value.extraSystemPrompt } : {}),
      messages: value.messages as AgentMessage[],
      turns: value.turns as PersistedTurn[],
    });
  } catch {
    return undefined;
  }
}

function normalizeContextStats(value: unknown): PersistedContextStats {
  if (!isRecord(value)) {
    return {
      historyCharacters: 0,
      contextCharacters: 0,
      droppedMessages: 0,
      compactedToolMessages: 0,
      compacted: false,
    };
  }
  return {
    historyCharacters: readNonNegativeInteger(value.historyCharacters) ?? 0,
    contextCharacters: readNonNegativeInteger(value.contextCharacters) ?? 0,
    droppedMessages: readNonNegativeInteger(value.droppedMessages) ?? 0,
    compactedToolMessages: readNonNegativeInteger(value.compactedToolMessages) ?? 0,
    compacted: value.compacted === true,
  };
}

function normalizeMessage(value: unknown): AgentMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string") return undefined;
  if (value.role === "user" && typeof value.content === "string") {
    const synthetic = normalizeSyntheticUserMessage(value.synthetic);
    return {
      role: "user",
      content: redactPersistedText(value.content).slice(0, MAX_MESSAGE_TEXT),
      ...(synthetic ? { synthetic } : {}),
    };
  }
  if (value.role === "user" && Array.isArray(value.content)) {
    const content = normalizeContentParts(value.content);
    const synthetic = normalizeSyntheticUserMessage(value.synthetic);
    return content.length > 0 ? { role: "user", content, ...(synthetic ? { synthetic } : {}) } : undefined;
  }
  if (value.role === "assistant" && typeof value.content === "string" && Array.isArray(value.toolCalls)) {
    const reasoningContent = typeof value.reasoningContent === "string"
      ? redactPersistedText(value.reasoningContent).slice(0, MAX_MESSAGE_TEXT)
      : undefined;
    return {
      role: "assistant",
      content: redactPersistedText(value.content).slice(0, MAX_MESSAGE_TEXT),
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls: value.toolCalls.slice(0, 64).flatMap((call) => {
        if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string") return [];
        return [{
          id: readSafeId(call.id, "tool call id"),
          name: readSafeId(call.name, "tool name"),
          arguments: compactJsonString(typeof call.arguments === "string" ? call.arguments : "{}", MAX_TOOL_TEXT),
        }];
      }),
    };
  }
  if (
    value.role === "tool" &&
    typeof value.callId === "string" &&
    typeof value.name === "string" &&
    typeof value.content === "string"
  ) {
    return {
      role: "tool",
      callId: readSafeId(value.callId, "tool call id"),
      name: readSafeId(value.name, "tool name"),
      content: sanitizeJsonString(value.content).slice(0, MAX_TOOL_TEXT),
    };
  }
  return undefined;
}

function normalizeContentParts(value: readonly unknown[]): ContentPart[] {
  const result: ContentPart[] = [];
  const imageIds = new Set<string>();
  let remainingText = MAX_MESSAGE_TEXT;
  for (const rawPart of value.slice(0, 16)) {
    if (!isRecord(rawPart) || typeof rawPart.type !== "string") continue;
    if (rawPart.type === "text" && typeof rawPart.text === "string") {
      const text = redactPersistedText(rawPart.text).slice(0, remainingText);
      remainingText -= text.length;
      result.push({ type: "text", text });
      continue;
    }
    if (
      rawPart.type !== "image" ||
      typeof rawPart.attachmentId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawPart.attachmentId) ||
      imageIds.has(rawPart.attachmentId) ||
      !isSupportedImageMimeType(rawPart.mimeType) ||
      (rawPart.detail !== "low" && rawPart.detail !== "high") ||
      imageIds.size >= 4
    ) {
      continue;
    }
    imageIds.add(rawPart.attachmentId);
    const annotations = normalizePersistedAnnotations(rawPart.annotations);
    result.push({
      type: "image",
      attachmentId: rawPart.attachmentId,
      mimeType: rawPart.mimeType,
      detail: rawPart.detail,
      ...(annotations ? { annotations } : {}),
    });
  }
  return result;
}

function normalizeSyntheticUserMessage(
  value: unknown,
): Extract<AgentMessage, { role: "user" }>["synthetic"] | undefined {
  if (
    !isRecord(value) ||
    value.kind !== "tool_observation" ||
    typeof value.callId !== "string" ||
    !value.callId ||
    value.callId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.callId)
  ) return undefined;
  return { kind: "tool_observation", callId: value.callId };
}

function normalizeAttachmentReferences(value: readonly unknown[]): PersistedAttachmentReference[] {
  const result: PersistedAttachmentReference[] = [];
  const ids = new Set<string>();
  for (const rawReference of value.slice(0, 4)) {
    if (
      !isRecord(rawReference) ||
      typeof rawReference.attachmentId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawReference.attachmentId) ||
      ids.has(rawReference.attachmentId) ||
      !isSupportedImageMimeType(rawReference.mimeType) ||
      (rawReference.detail !== "low" && rawReference.detail !== "high")
    ) {
      continue;
    }
    const byteSize = readNonNegativeInteger(rawReference.byteSize);
    const width = readNonNegativeInteger(rawReference.width);
    const height = readNonNegativeInteger(rawReference.height);
    if (!byteSize || !width || !height) continue;
    const sources = new Set(["file", "clipboard", "project_resource", "editor_viewport", "game_frame"]);
    const source = typeof rawReference.source === "string" && sources.has(rawReference.source)
      ? rawReference.source as PersistedAttachmentReference["source"]
      : undefined;
    const name = normalizeOptionalPersistedText(rawReference.name, 256);
    const runId = normalizeOptionalPersistedText(rawReference.runId, 128);
    const sceneId = normalizeOptionalPersistedText(rawReference.sceneId, 128);
    const scenePath = normalizeOptionalPersistedText(rawReference.scenePath, 1_024);
    const capturedAtMs = readNonNegativeInteger(rawReference.capturedAtMs);
    const viewportWidth = readBoundedPositiveInteger(rawReference.viewportWidth, 16_384);
    const viewportHeight = readBoundedPositiveInteger(rawReference.viewportHeight, 16_384);
    const frame = readNonNegativeInteger(rawReference.frame);
    const annotations = normalizePersistedAnnotations(rawReference.annotations);
    const annotatedFrom = typeof rawReference.annotatedFrom === "string" && /^[a-f0-9]{64}$/u.test(rawReference.annotatedFrom)
      ? rawReference.annotatedFrom
      : undefined;
    ids.add(rawReference.attachmentId);
    result.push({
      attachmentId: rawReference.attachmentId,
      mimeType: rawReference.mimeType,
      detail: rawReference.detail,
      ...(annotations ? { annotations } : {}),
      ...(annotatedFrom ? { annotatedFrom } : {}),
      byteSize,
      width,
      height,
      ...(source ? { source } : {}),
      ...(name ? { name } : {}),
      ...(runId ? { runId } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(scenePath ? { scenePath } : {}),
      ...(capturedAtMs !== undefined ? { capturedAtMs } : {}),
      ...(viewportWidth !== undefined && viewportHeight !== undefined
        ? { viewportWidth, viewportHeight }
        : {}),
      ...(frame !== undefined ? { frame } : {}),
    });
  }
  return result;
}

function normalizePersistedAnnotations(value: unknown): ImageAnnotation[] | undefined {
  if (value === undefined) return undefined;
  try {
    const annotations = parseImageAnnotations(value);
    return annotations.length > 0 ? annotations : undefined;
  } catch {
    return undefined;
  }
}

function isSupportedImageMimeType(value: unknown): value is PersistedAttachmentReference["mimeType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function normalizeOptionalPersistedText(value: unknown, maximumLength: number): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return undefined;
  return redactPersistedText(value);
}

function readBoundedPositiveInteger(value: unknown, maximum: number): number | undefined {
  const normalized = readNonNegativeInteger(value);
  return normalized !== undefined && normalized > 0 && normalized <= maximum ? normalized : undefined;
}

function normalizeMessagesForStorage(messages: readonly AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pendingCallIds: Set<string> | undefined;
  let completedCallIds = new Set<string>();
  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (!normalized) continue;
    if (normalized.role === "user") {
      if (normalized.synthetic) {
        if (completedCallIds.has(normalized.synthetic.callId)) {
          result.push(normalized);
          completedCallIds.delete(normalized.synthetic.callId);
        }
        continue;
      }
      pendingCallIds = undefined;
      completedCallIds.clear();
      result.push(normalized);
      continue;
    }
    if (normalized.role === "assistant") {
      pendingCallIds = new Set(normalized.toolCalls.map((call) => call.id));
      completedCallIds = new Set<string>();
      result.push(normalized);
      continue;
    }
    if (!pendingCallIds?.has(normalized.callId)) continue;
    result.push(normalized);
    pendingCallIds.delete(normalized.callId);
    completedCallIds.add(normalized.callId);
  }
  return result;
}

function normalizeEntry(value: unknown): PersistedTurnEntry | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.itemId !== "string") return undefined;
  const itemId = readSafeId(value.itemId, "item id");
  if (value.kind === "context") {
    return {
      kind: "context",
      itemId,
      data: compactUnknown(value.data, MAX_TOOL_TEXT),
    };
  }
  if (value.kind === "assistant" && typeof value.text === "string" && typeof value.reasoning === "string") {
    return {
      kind: "assistant",
      itemId,
      text: redactPersistedText(value.text).slice(0, MAX_MESSAGE_TEXT),
      reasoning: redactPersistedText(value.reasoning).slice(0, MAX_REASONING_TEXT),
    };
  }
  if (value.kind === "tool" && typeof value.name === "string") {
    return {
      kind: "tool",
      itemId,
      name: readSafeId(value.name, "tool name"),
      arguments: compactUnknown(value.arguments, MAX_TOOL_TEXT),
      output: compactUnknown(value.output, MAX_TOOL_TEXT),
    };
  }
  return undefined;
}

function compactUnknown(value: unknown, maximumCharacters: number): unknown {
  const sanitized = sanitizeJsonValue(value, 0);
  const encoded = JSON.stringify(sanitized);
  if (encoded.length <= maximumCharacters) return sanitized;
  return {
    persisted_truncated: true,
    preview: truncate(redactPersistedText(encoded), Math.min(maximumCharacters, 8_000)),
  };
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactPersistedText(value).slice(0, MAX_MESSAGE_TEXT);
  if (depth >= MAX_JSON_DEPTH) return "[Maximum persistence depth reached]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_JSON_ITEMS).map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_JSON_ITEMS)) {
      result[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeJsonValue(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

function redactPersistedText(value: string): string {
  return value
    .replace(
      /((?:"|')(?:api[_-]?key|authorization|access[_-]?token|password|secret|token)(?:"|')\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,\s}\]]+)/giu,
      '$1"[REDACTED]"',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]");
}

function sanitizeJsonString(value: string): string {
  try {
    return JSON.stringify(sanitizeJsonValue(JSON.parse(value) as unknown, 0));
  } catch {
    return redactPersistedText(value);
  }
}

function compactJsonString(value: string, maximumCharacters: number): string {
  let sanitized: string;
  try {
    const parsed = JSON.parse(value) as unknown;
    sanitized = isRecord(parsed)
      ? JSON.stringify(sanitizeJsonValue(parsed, 0))
      : JSON.stringify({ persisted_invalid_arguments: true, error: "Tool arguments were not a JSON object" });
  } catch {
    sanitized = JSON.stringify({
      persisted_invalid_arguments: true,
      preview: truncate(redactPersistedText(value), 2_000),
    });
  }
  if (sanitized.length <= maximumCharacters) return sanitized;
  let preview = redactPersistedText(sanitized).slice(0, Math.max(0, Math.floor(maximumCharacters / 2)));
  let encoded = JSON.stringify({ persisted_truncated: true, preview });
  while (encoded.length > maximumCharacters && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
    encoded = JSON.stringify({ persisted_truncated: true, preview });
  }
  return encoded.length <= maximumCharacters ? encoded : "{}";
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|password|secret|token)/iu.test(key);
}

function normalizeUsage(value: unknown): PersistedUsage {
  if (!isRecord(value)) return {};
  const inputTokens = readNonNegativeInteger(value.inputTokens);
  const outputTokens = readNonNegativeInteger(value.outputTokens);
  const totalTokens = readNonNegativeInteger(value.totalTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readRevision(value: unknown): number {
  return readNonNegativeInteger(value) ?? 0;
}

function resolveTurnMessageStart(messages: readonly AgentMessage[], turn: PersistedTurn): number {
  if (
    turn.messageStartIndex !== undefined &&
    Number.isSafeInteger(turn.messageStartIndex) &&
    turn.messageStartIndex >= 0 &&
    turn.messageStartIndex <= messages.length
  ) {
    return turn.messageStartIndex;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return messages.length;
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  if (message.role === "assistant") {
    return { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => ({ ...part })),
      ...(message.synthetic ? { synthetic: { ...message.synthetic } } : {}),
    };
  }
  return { ...message };
}

function readSafeId(value: string, field: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function readIsoDate(value: string, field: string): string {
  if (value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}`);
  return new Date(value).toISOString();
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^session_[A-Za-z0-9-]{8,128}$/u.test(value);
}

function isTurnStatus(value: unknown): value is PersistedTurnStatus {
  return value === "running" || value === "completed" || value === "interrupted" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters
    ? value
    : `${value.slice(0, Math.max(0, maximumCharacters - 24)).trimEnd()}\n[Persisted content truncated]`;
}

function normalizeWorkspaceIdentity(workspace: string): string {
  const normalized = workspace.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
