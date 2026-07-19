import { createHash, type Hash } from "node:crypto";

const DEFAULT_EMERGENCY_MODEL_STEP_LIMIT = 512;
const DEFAULT_EMERGENCY_TOOL_CALL_LIMIT = 4_096;
const DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT = 8;
const DEFAULT_TRACKED_FINGERPRINT_LIMIT = 1_024;
const REPEATED_IDENTICAL_BATCH_LIMIT = 2;
const MAX_CANONICAL_DEPTH = 256;

export interface AgentLoopToolCall {
  name: string;
  arguments: string;
}

export interface AgentLoopToolOutcome {
  output: unknown;
  successful?: boolean;
}

export interface AgentLoopGuardOptions {
  emergencyModelStepLimit?: number;
  emergencyToolCallLimit?: number;
  consecutiveNoProgressLimit?: number;
  trackedFingerprintLimit?: number;
  normalizeOutput?: (output: unknown, call: Readonly<AgentLoopToolCall>) => unknown;
  isSuccessfulOutcome?: (output: unknown, call: Readonly<AgentLoopToolCall>) => boolean;
}

export type AgentLoopStopReason =
  | "repeated_tool_batch"
  | "consecutive_no_progress"
  | "emergency_model_step_limit"
  | "emergency_tool_call_limit";

export type AgentLoopDecision =
  | { action: "continue" }
  | { action: "stop"; reason: AgentLoopStopReason; message: string };

export interface AgentLoopGuardSnapshot {
  modelSteps: number;
  toolCalls: number;
  consecutiveNoProgressSteps: number;
  progressEpoch: number;
  trackedToolBatches: number;
  trackedSuccessfulOutcomes: number;
  hasPendingToolBatch: boolean;
}

interface BatchHistory {
  outcomeFingerprint: string;
  identicalOutcomeCount: number;
  progressEpoch: number;
}

interface PendingBatch {
  fingerprint: string;
  calls: AgentLoopToolCall[];
  callFingerprints: string[];
}

interface CanonicalState {
  seen: WeakMap<object, number>;
  nextObjectId: number;
}

const CONTINUE: AgentLoopDecision = { action: "continue" };

/**
 * Guards an agent loop using observed progress instead of a small model-step budget.
 * A caller should invoke the three checkpoints in order for each model/tool cycle.
 */
export class AgentLoopGuard {
  readonly #emergencyModelStepLimit: number;
  readonly #emergencyToolCallLimit: number;
  readonly #consecutiveNoProgressLimit: number;
  readonly #trackedFingerprintLimit: number;
  readonly #normalizeOutput: (output: unknown, call: Readonly<AgentLoopToolCall>) => unknown;
  readonly #isSuccessfulOutcome: (
    output: unknown,
    call: Readonly<AgentLoopToolCall>,
  ) => boolean;
  readonly #batchHistory = new Map<string, BatchHistory>();
  readonly #successfulOutcomes = new Map<string, true>();
  #modelSteps = 0;
  #toolCalls = 0;
  #consecutiveNoProgressSteps = 0;
  #progressEpoch = 0;
  #pending: PendingBatch | undefined;

  constructor(options: AgentLoopGuardOptions = {}) {
    this.#emergencyModelStepLimit = positiveInteger(
      options.emergencyModelStepLimit ?? DEFAULT_EMERGENCY_MODEL_STEP_LIMIT,
      "emergencyModelStepLimit",
    );
    this.#emergencyToolCallLimit = positiveInteger(
      options.emergencyToolCallLimit ?? DEFAULT_EMERGENCY_TOOL_CALL_LIMIT,
      "emergencyToolCallLimit",
    );
    this.#consecutiveNoProgressLimit = positiveInteger(
      options.consecutiveNoProgressLimit ?? DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT,
      "consecutiveNoProgressLimit",
    );
    this.#trackedFingerprintLimit = positiveInteger(
      options.trackedFingerprintLimit ?? DEFAULT_TRACKED_FINGERPRINT_LIMIT,
      "trackedFingerprintLimit",
    );
    this.#normalizeOutput = options.normalizeOutput ?? ((output) => output);
    this.#isSuccessfulOutcome = options.isSuccessfulOutcome ?? defaultSuccessfulOutcome;
  }

  beforeModelStep(): AgentLoopDecision {
    if (this.#pending) {
      throw new Error("Cannot begin a model step while a tool batch is pending");
    }
    if (this.#modelSteps >= this.#emergencyModelStepLimit) {
      return stop(
        "emergency_model_step_limit",
        `Agent reached the emergency limit of ${this.#emergencyModelStepLimit} model steps`,
      );
    }
    this.#modelSteps += 1;
    return CONTINUE;
  }

  /** Reserves a tool batch and can reject a known third identical execution. */
  beforeToolBatch(calls: readonly Readonly<AgentLoopToolCall>[]): AgentLoopDecision {
    if (this.#pending) throw new Error("A tool batch is already pending");
    if (calls.length === 0) throw new Error("A tool batch must contain at least one call");

    const copiedCalls = calls.map((call) => ({ name: call.name.trim(), arguments: call.arguments }));
    const callFingerprints = copiedCalls.map(fingerprintToolCall);
    const fingerprint = canonicalFingerprint(callFingerprints);
    const previous = this.#batchHistory.get(fingerprint);
    if (
      previous &&
      previous.progressEpoch === this.#progressEpoch &&
      previous.identicalOutcomeCount >= REPEATED_IDENTICAL_BATCH_LIMIT
    ) {
      touch(this.#batchHistory, fingerprint, previous);
      return stop(
        "repeated_tool_batch",
        "The same normalized tool batch produced identical outputs twice without intervening progress; stopped before a third execution",
      );
    }

    if (this.#toolCalls + copiedCalls.length > this.#emergencyToolCallLimit) {
      return stop(
        "emergency_tool_call_limit",
        `Agent reached the emergency limit of ${this.#emergencyToolCallLimit} tool calls`,
      );
    }

    this.#toolCalls += copiedCalls.length;
    this.#pending = { fingerprint, calls: copiedCalls, callFingerprints };
    return CONTINUE;
  }

  /** Records the reserved batch's outputs and reports whether useful progress stalled. */
  afterToolBatch(outcomes: readonly Readonly<AgentLoopToolOutcome>[]): AgentLoopDecision {
    const pending = this.#pending;
    if (!pending) throw new Error("No tool batch is pending");
    if (outcomes.length !== pending.calls.length) {
      throw new Error(
        `Expected ${pending.calls.length} tool outcomes, received ${outcomes.length}`,
      );
    }

    const normalized = outcomes.map((outcome, index) => {
      const call = pending.calls[index];
      if (!call) throw new Error("Tool outcome does not have a matching call");
      const output = this.#normalizeOutput(outcome.output, call);
      const successful = outcome.successful ?? this.#isSuccessfulOutcome(output, call);
      return { output, successful };
    });
    this.#pending = undefined;

    let madeProgress = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const outcome = normalized[index];
      const callFingerprint = pending.callFingerprints[index];
      if (!outcome || !callFingerprint || !outcome.successful) continue;
      const outcomeFingerprint = canonicalFingerprint({
        call: callFingerprint,
        output: outcome.output,
      });
      if (!hasAndTouch(this.#successfulOutcomes, outcomeFingerprint)) {
        madeProgress = true;
        remember(
          this.#successfulOutcomes,
          outcomeFingerprint,
          true,
          this.#trackedFingerprintLimit,
        );
      }
    }

    if (madeProgress) {
      this.#progressEpoch += 1;
      this.#consecutiveNoProgressSteps = 0;
    } else {
      this.#consecutiveNoProgressSteps += 1;
    }

    const outcomeFingerprint = canonicalFingerprint(normalized);
    const previous = this.#batchHistory.get(pending.fingerprint);
    const identicalOutcomeCount =
      previous?.progressEpoch === this.#progressEpoch &&
      previous.outcomeFingerprint === outcomeFingerprint
        ? previous.identicalOutcomeCount + 1
        : 1;
    remember(
      this.#batchHistory,
      pending.fingerprint,
      { outcomeFingerprint, identicalOutcomeCount, progressEpoch: this.#progressEpoch },
      this.#trackedFingerprintLimit,
    );

    if (this.#consecutiveNoProgressSteps >= this.#consecutiveNoProgressLimit) {
      return stop(
        "consecutive_no_progress",
        `Agent made no novel successful tool progress for ${this.#consecutiveNoProgressSteps} consecutive steps`,
      );
    }
    return CONTINUE;
  }

  snapshot(): AgentLoopGuardSnapshot {
    return {
      modelSteps: this.#modelSteps,
      toolCalls: this.#toolCalls,
      consecutiveNoProgressSteps: this.#consecutiveNoProgressSteps,
      progressEpoch: this.#progressEpoch,
      trackedToolBatches: this.#batchHistory.size,
      trackedSuccessfulOutcomes: this.#successfulOutcomes.size,
      hasPendingToolBatch: this.#pending !== undefined,
    };
  }
}

/** Produces a stable, fixed-size fingerprint for JSON-like values. */
export function canonicalFingerprint(value: unknown): string {
  const hash = createHash("sha256");
  writeCanonical(hash, value, { seen: new WeakMap<object, number>(), nextObjectId: 0 }, 0);
  return hash.digest("base64url");
}

function fingerprintToolCall(call: Readonly<AgentLoopToolCall>): string {
  return canonicalFingerprint({
    name: call.name.trim(),
    arguments: normalizeToolArguments(call.arguments),
  });
}

function normalizeToolArguments(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { invalidJson: trimmed };
  }
}

function defaultSuccessfulOutcome(output: unknown): boolean {
  if (!isRecord(output)) return true;
  if (output.ok === false) return false;
  return !("error" in output && output.error !== undefined && output.ok !== true);
}

function writeCanonical(hash: Hash, value: unknown, state: CanonicalState, depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    token(hash, "depth", String(MAX_CANONICAL_DEPTH));
    return;
  }
  if (value === null) {
    token(hash, "null", "");
    return;
  }

  switch (typeof value) {
    case "undefined":
      token(hash, "undefined", "");
      return;
    case "boolean":
      token(hash, "boolean", value ? "1" : "0");
      return;
    case "number":
      token(hash, "number", canonicalNumber(value));
      return;
    case "bigint":
      token(hash, "bigint", value.toString());
      return;
    case "string":
      token(hash, "string", value);
      return;
    case "symbol":
      token(hash, "symbol", value.description ?? "");
      return;
    case "function":
      token(hash, "function", value.name);
      return;
  }

  const object = value as object;
  const seenId = state.seen.get(object);
  if (seenId !== undefined) {
    token(hash, "reference", String(seenId));
    return;
  }
  const objectId = state.nextObjectId;
  state.nextObjectId += 1;
  state.seen.set(object, objectId);

  if (Array.isArray(value)) {
    token(hash, "array-start", String(value.length));
    for (let index = 0; index < value.length; index += 1) {
      if (index in value) writeCanonical(hash, value[index], state, depth + 1);
      else token(hash, "hole", "");
    }
    token(hash, "array-end", "");
    return;
  }
  if (value instanceof Date) {
    token(hash, "date", Number.isNaN(value.valueOf()) ? "invalid" : value.toISOString());
    return;
  }
  if (value instanceof Error) {
    token(hash, "error-name", value.name);
    token(hash, "error-message", value.message);
  }
  if (value instanceof ArrayBuffer) {
    token(hash, "array-buffer", Buffer.from(value).toString("base64"));
    return;
  }
  if (ArrayBuffer.isView(value)) {
    token(
      hash,
      Object.prototype.toString.call(value),
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    );
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  token(hash, "object-start", Object.prototype.toString.call(value));
  for (const key of keys) {
    token(hash, "key", key);
    writeCanonical(hash, record[key], state, depth + 1);
  }
  token(hash, "object-end", "");
}

function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function token(hash: Hash, kind: string, value: string): void {
  hash.update(kind);
  hash.update(":");
  hash.update(Buffer.byteLength(value).toString());
  hash.update(":");
  hash.update(value);
  hash.update(";");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function stop(reason: AgentLoopStopReason, message: string): AgentLoopDecision {
  return { action: "stop", reason, message };
}

function hasAndTouch<V>(map: Map<string, V>, key: string): boolean {
  const value = map.get(key);
  if (value === undefined) return false;
  touch(map, key, value);
  return true;
}

function touch<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  touch(map, key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
