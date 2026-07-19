import { randomUUID } from "node:crypto";
import type {
  EditorSceneLease,
  EditorToolRequestData,
  EditorToolResponseError,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SETTLED_REQUESTS = 2_048;

export interface EditorToolExecutionContext {
  signal: AbortSignal;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  sceneLease?: Readonly<EditorSceneLease>;
}

export interface EditorToolClient {
  execute(
    tool: string,
    args: Record<string, unknown>,
    context: EditorToolExecutionContext,
  ): Promise<Record<string, unknown>>;
}

export interface EditorToolBridgeOptions {
  timeoutMs?: number;
}

export type EditorToolRequestEmitter = (
  request: EditorToolRequestData,
  context: EditorToolExecutionContext,
) => void;

export class EditorToolBridgeError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "EditorToolBridgeError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: EditorToolBridgeError) => void;
}

export class EditorToolBridge implements EditorToolClient {
  readonly #emit: EditorToolRequestEmitter;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #settled = new Set<string>();
  readonly #settledOrder: string[] = [];
  #closed = false;

  constructor(emit: EditorToolRequestEmitter, options: EditorToolBridgeOptions = {}) {
    this.#emit = emit;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 300_000) {
      throw new Error("Editor tool timeout must be between 1 and 300000 milliseconds");
    }
  }

  execute(
    tool: string,
    args: Record<string, unknown>,
    context: EditorToolExecutionContext,
  ): Promise<Record<string, unknown>> {
    const normalizedTool = tool.trim();
    if (!normalizedTool) {
      return Promise.reject(new EditorToolBridgeError("EDITOR_TOOL_INVALID", "Editor tool name is required"));
    }
    if (!isRecord(args)) {
      return Promise.reject(
        new EditorToolBridgeError("EDITOR_TOOL_INVALID", "Editor tool arguments must be an object"),
      );
    }
    if (!context?.signal) {
      return Promise.reject(
        new EditorToolBridgeError("EDITOR_TOOL_INVALID", "Editor tool execution requires an AbortSignal"),
      );
    }
    if (this.#closed) {
      return Promise.reject(
        new EditorToolBridgeError("EDITOR_BRIDGE_DISCONNECTED", "Godot editor bridge is disconnected"),
      );
    }
    if (context.signal.aborted) {
      return Promise.reject(editorToolAbortError(normalizedTool));
    }

    const requestId = `editor_${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const abortListener = (): void => {
        this.#rejectPending(requestId, editorToolAbortError(normalizedTool, requestId));
      };
      const timer = setTimeout(() => {
        this.#rejectPending(
          requestId,
          new EditorToolBridgeError(
            "EDITOR_TOOL_TIMEOUT",
            `Godot editor tool \"${normalizedTool}\" timed out after ${this.#timeoutMs} ms`,
            { request_id: requestId, tool: normalizedTool, timeout_ms: this.#timeoutMs },
          ),
        );
      }, this.#timeoutMs);
      const pending: PendingRequest = {
        requestId,
        tool: normalizedTool,
        signal: context.signal,
        abortListener,
        timer,
        resolve,
        reject,
      };
      this.#pending.set(requestId, pending);
      context.signal.addEventListener("abort", abortListener, { once: true });

      try {
        this.#emit({
          request_id: requestId,
          tool: normalizedTool,
          arguments: args,
          ...(context.sceneLease ? { scene_lease: copyEditorSceneLease(context.sceneLease) } : {}),
        }, context);
      } catch (error) {
        this.#rejectPending(
          requestId,
          new EditorToolBridgeError(
            "EDITOR_BRIDGE_SEND_FAILED",
            error instanceof Error ? error.message : String(error),
            { request_id: requestId, tool: normalizedTool },
          ),
        );
      }
    });
  }

  respond(value: unknown): string {
    const response = asRecord(value);
    if (!response) {
      throw new EditorToolBridgeError(
        "EDITOR_RESPONSE_INVALID",
        "editor.tool.respond params must be an object",
      );
    }
    const requestId = asNonEmptyString(response.request_id);
    if (!requestId) {
      throw new EditorToolBridgeError(
        "EDITOR_RESPONSE_INVALID",
        "editor.tool.respond requires a non-empty request_id",
      );
    }

    const pending = this.#pending.get(requestId);
    if (!pending) {
      if (this.#settled.has(requestId)) {
        throw new EditorToolBridgeError(
          "EDITOR_REQUEST_ALREADY_RESOLVED",
          `Editor tool request has already been resolved: ${requestId}`,
          { request_id: requestId },
        );
      }
      throw new EditorToolBridgeError(
        "EDITOR_REQUEST_NOT_FOUND",
        `Unknown editor tool request: ${requestId}`,
        { request_id: requestId },
      );
    }

    const hasResult = Object.hasOwn(response, "result");
    const hasError = Object.hasOwn(response, "error");
    if (hasResult === hasError) {
      const error = new EditorToolBridgeError(
        "EDITOR_RESPONSE_INVALID",
        "editor.tool.respond must contain exactly one of result or error",
        { request_id: requestId },
      );
      this.#rejectPending(requestId, error);
      throw error;
    }

    if (hasError) {
      let responseError: EditorToolResponseError;
      try {
        responseError = parseResponseError(response.error, requestId);
      } catch (error) {
        this.#rejectPending(
          requestId,
          error instanceof EditorToolBridgeError
            ? error
            : new EditorToolBridgeError("EDITOR_RESPONSE_INVALID", String(error)),
        );
        throw error;
      }
      this.#rejectPending(
        requestId,
        new EditorToolBridgeError(responseError.code, responseError.message, responseError.data),
      );
      return requestId;
    }

    if (!isRecord(response.result)) {
      const error = new EditorToolBridgeError(
        "EDITOR_RESPONSE_INVALID",
        "Editor tool result must be an object",
        { request_id: requestId },
      );
      this.#rejectPending(requestId, error);
      throw error;
    }
    this.#resolvePending(requestId, response.result);
    return requestId;
  }

  reset(
    code = "EDITOR_BRIDGE_RECONFIGURED",
    message = "Godot editor bridge was reset during runtime reconfiguration",
  ): void {
    for (const pending of [...this.#pending.values()]) {
      this.#rejectPending(
        pending.requestId,
        new EditorToolBridgeError(code, message, {
          request_id: pending.requestId,
          tool: pending.tool,
        }),
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.reset("EDITOR_BRIDGE_DISCONNECTED", "Godot editor bridge disconnected");
  }

  #resolvePending(requestId: string, result: Record<string, unknown>): void {
    const pending = this.#takePending(requestId);
    pending?.resolve(result);
  }

  #rejectPending(requestId: string, error: EditorToolBridgeError): void {
    const pending = this.#takePending(requestId);
    pending?.reject(error);
  }

  #takePending(requestId: string): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    this.#rememberSettled(requestId);
    return pending;
  }

  #rememberSettled(requestId: string): void {
    this.#settled.add(requestId);
    this.#settledOrder.push(requestId);
    while (this.#settledOrder.length > MAX_SETTLED_REQUESTS) {
      const oldest = this.#settledOrder.shift();
      if (oldest) this.#settled.delete(oldest);
    }
  }
}

function copyEditorSceneLease(lease: Readonly<EditorSceneLease>): EditorSceneLease {
  return {
    scene_id: lease.scene_id,
    scene_path: lease.scene_path,
    scene_revision: lease.scene_revision,
  };
}

function parseResponseError(value: unknown, requestId: string): EditorToolResponseError {
  const error = asRecord(value);
  if (!error) {
    throw new EditorToolBridgeError(
      "EDITOR_RESPONSE_INVALID",
      "Editor tool error must be an object",
      { request_id: requestId },
    );
  }
  const code = asNonEmptyString(error.code);
  const message = asNonEmptyString(error.message);
  if (!code || !message) {
    throw new EditorToolBridgeError(
      "EDITOR_RESPONSE_INVALID",
      "Editor tool error requires non-empty code and message",
      { request_id: requestId },
    );
  }
  return {
    code,
    message,
    ...(Object.hasOwn(error, "data") ? { data: error.data } : {}),
  };
}

function editorToolAbortError(tool: string, requestId?: string): EditorToolBridgeError {
  return new EditorToolBridgeError(
    "EDITOR_TOOL_ABORTED",
    `Godot editor tool \"${tool}\" was cancelled`,
    { ...(requestId ? { request_id: requestId } : {}), tool },
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
