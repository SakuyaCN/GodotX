import { decodeSse } from "../sse.js";
import { makeProviderHttpError } from "./errors.js";
import type {
  AgentMessage,
  ContentPart,
  ModelProvider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderRequest,
  ProviderResolvedAttachment,
  ProviderTurnResult,
  ProviderUsage,
  ToolCall,
} from "./types.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
export const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_MAX_TOKENS = 16_384;
const MAX_MODEL_LIST_BYTES = 2_000_000;
const MAX_MODEL_COUNT = 5_000;
const MAX_MODEL_PAGES = 20;
const MAX_SSE_EVENT_BYTES = 1_000_000;
const MAX_TEXT_CHARACTERS = 4_000_000;
const MAX_REASONING_CHARACTERS = 2_000_000;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_CHARACTERS = 1_000_000;

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
}

type AnthropicRole = "user" | "assistant";

interface AnthropicMessage {
  role: AnthropicRole;
  content: Array<Record<string, unknown>>;
}

type StreamBlock =
  | { kind: "text" }
  | { kind: "thinking" }
  | {
      kind: "tool";
      id: string;
      name: string;
      initialInput: Record<string, unknown>;
      argumentsText: string;
      finalized: boolean;
    };

export class AnthropicProvider implements ModelProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.#baseUrl = normalizeAnthropicBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  getModelCapabilities(_model: string): ProviderModelCapabilities {
    return anthropicModelCapabilities();
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const models = new Map<string, ProviderModel>();
    const seenCursors = new Set<string>();
    let nextUrl = `${this.#baseUrl}/models`;

    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const timeoutSignal = AbortSignal.timeout(10_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await this.#fetch(nextUrl, {
        method: "GET",
        headers: this.#headers("application/json"),
        redirect: "error",
        signal: requestSignal,
      });
      const text = await readBoundedResponseText(
        response,
        MAX_MODEL_LIST_BYTES,
        "Anthropic model list exceeds the 2 MB limit",
      );
      if (!response.ok) throw makeProviderHttpError(response.status, this.#redact(text));

      const payload = parseJsonObject(text, (value) => this.#redact(value), "Anthropic model list");
      if (payload.error !== undefined || payload.type === "error") {
        throw makeProviderHttpError(response.status, this.#redact(text.slice(0, 2_000)));
      }
      if (!Array.isArray(payload.data)) {
        throw new Error("Anthropic model list must contain a data array");
      }
      if (models.size + payload.data.length > MAX_MODEL_COUNT) {
        throw new Error("Anthropic model list exceeds the 5000 item limit");
      }

      for (const rawModel of payload.data) {
        const model = asRecord(rawModel);
        const id = safeText(model?.id, 512);
        if (!id) continue;
        const displayName = safeText(model?.display_name, 512);
        models.set(id, {
          id,
          ...(displayName ? { displayName } : {}),
          ownedBy: "anthropic",
          capabilities: anthropicModelCapabilities(),
        });
      }

      if (payload.has_more !== true) break;
      const cursor = safeText(payload.last_id, 512)
        ?? safeText(asRecord(payload.data.at(-1))?.id, 512);
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error("Anthropic model pagination returned an invalid cursor");
      }
      seenCursors.add(cursor);
      nextUrl = `${this.#baseUrl}/models?after_id=${encodeURIComponent(cursor)}`;
    }

    return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    const model = safeText(request.model, 512);
    if (!model) throw new Error("Anthropic model is required");
    const messages = await toAnthropicMessages(request.messages, request.resolveAttachment);
    if (messages.length === 0) throw new Error("Anthropic request must contain at least one message");

    const body = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: request.systemPrompt,
      messages,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      stream: true,
    };
    const response = await this.#fetch(`${this.#baseUrl}/messages`, {
      method: "POST",
      headers: this.#headers("text/event-stream"),
      body: JSON.stringify(body),
      redirect: "error",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      const text = await readBoundedResponseText(response, 2_000_000, "Anthropic error response is too large");
      throw makeProviderHttpError(response.status, this.#redact(text));
    }
    if (!response.body) throw new Error("Anthropic stream response has no body");

    let text = "";
    let reasoning = "";
    let usage: ProviderUsage = {};
    let sawMessageStop = false;
    const blocks = new Map<number, StreamBlock>();
    const toolCalls = new Map<number, ToolCall>();

    const updateUsage = (rawUsage: unknown): void => {
      const source = asRecord(rawUsage);
      if (!source) return;
      const inputTokens = nonNegativeInteger(source.input_tokens);
      const outputTokens = nonNegativeInteger(source.output_tokens);
      usage = {
        ...(inputTokens !== undefined ? { inputTokens } : usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      };
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        request.onEvent({ type: "usage", usage: { ...usage } });
      }
    };

    const finalizeTool = (index: number, block: Extract<StreamBlock, { kind: "tool" }>): void => {
      if (block.finalized) return;
      block.finalized = true;
      const argumentsText = block.argumentsText || JSON.stringify(block.initialInput);
      if (argumentsText.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
        throw new Error("Anthropic tool arguments exceed the 1 MB limit");
      }
      toolCalls.set(index, {
        id: block.id,
        name: block.name,
        arguments: argumentsText || "{}",
      });
    };

    for await (const message of decodeSse(response.body)) {
      if (message.data.length > MAX_SSE_EVENT_BYTES) {
        throw new Error("Anthropic SSE event exceeds the 1 MB limit");
      }
      const event = parseJsonObject(
        message.data,
        (value) => this.#redact(value),
        "Anthropic SSE event",
      );
      const eventType = safeText(event.type, 128) ?? message.event ?? "";

      if (eventType === "error") {
        const streamError = asRecord(event.error);
        const errorMessage = safeText(streamError?.message, 2_000) ?? "Anthropic stream failed";
        throw new Error(this.#redact(errorMessage));
      }
      if (eventType === "message_start") {
        updateUsage(asRecord(event.message)?.usage);
        continue;
      }
      if (eventType === "content_block_start") {
        const index = streamIndex(event.index);
        const contentBlock = asRecord(event.content_block);
        const blockType = safeText(contentBlock?.type, 128);
        if (blockType === "text") {
          blocks.set(index, { kind: "text" });
          const initial = boundedString(contentBlock?.text, MAX_TEXT_CHARACTERS);
          if (initial) {
            text += initial;
            request.onEvent({ type: "text_delta", text: initial });
          }
        } else if (blockType === "thinking") {
          blocks.set(index, { kind: "thinking" });
          const initial = boundedString(contentBlock?.thinking, MAX_REASONING_CHARACTERS);
          if (initial) {
            reasoning += initial;
            request.onEvent({ type: "reasoning_delta", text: initial });
          }
        } else if (blockType === "tool_use") {
          if ([...blocks.values()].filter((value) => value.kind === "tool").length >= MAX_TOOL_CALLS) {
            throw new Error("Anthropic response contains too many tool calls");
          }
          const id = safeText(contentBlock?.id, 512);
          const name = safeText(contentBlock?.name, 512);
          if (!id || !name) throw new Error("Anthropic tool call is missing an id or name");
          const initialInput = asRecord(contentBlock?.input) ?? {};
          blocks.set(index, {
            kind: "tool",
            id,
            name,
            initialInput,
            argumentsText: "",
            finalized: false,
          });
          request.onEvent({ type: "tool_call_delta", id, name, argumentsDelta: "" });
        }
        continue;
      }
      if (eventType === "content_block_delta") {
        const index = streamIndex(event.index);
        const delta = asRecord(event.delta);
        const deltaType = safeText(delta?.type, 128);
        const block = blocks.get(index);
        if (deltaType === "text_delta") {
          const chunk = boundedString(delta?.text, MAX_TEXT_CHARACTERS) ?? "";
          if (text.length + chunk.length > MAX_TEXT_CHARACTERS) {
            throw new Error("Anthropic text output exceeds the 4 million character limit");
          }
          if (chunk) {
            text += chunk;
            request.onEvent({ type: "text_delta", text: chunk });
          }
        } else if (deltaType === "thinking_delta") {
          const chunk = boundedString(delta?.thinking, MAX_REASONING_CHARACTERS) ?? "";
          if (reasoning.length + chunk.length > MAX_REASONING_CHARACTERS) {
            throw new Error("Anthropic reasoning output exceeds the 2 million character limit");
          }
          if (chunk) {
            reasoning += chunk;
            request.onEvent({ type: "reasoning_delta", text: chunk });
          }
        } else if (deltaType === "input_json_delta") {
          if (!block || block.kind !== "tool") {
            throw new Error("Anthropic tool argument delta has no matching tool block");
          }
          const chunk = boundedString(delta?.partial_json, MAX_TOOL_ARGUMENT_CHARACTERS) ?? "";
          if (block.argumentsText.length + chunk.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
            throw new Error("Anthropic tool arguments exceed the 1 MB limit");
          }
          block.argumentsText += chunk;
          if (chunk) {
            request.onEvent({ type: "tool_call_delta", id: block.id, argumentsDelta: chunk });
          }
        }
        continue;
      }
      if (eventType === "content_block_stop") {
        const index = streamIndex(event.index);
        const block = blocks.get(index);
        if (block?.kind === "tool") finalizeTool(index, block);
        continue;
      }
      if (eventType === "message_delta") {
        updateUsage(event.usage);
        continue;
      }
      if (eventType === "message_stop") {
        sawMessageStop = true;
        break;
      }
    }

    if (!sawMessageStop) throw new Error("Anthropic stream ended before message_stop");
    for (const [index, block] of blocks) {
      if (block.kind === "tool") finalizeTool(index, block);
    }
    const orderedCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    return {
      message: {
        role: "assistant",
        content: text,
        toolCalls: orderedCalls,
        ...(reasoning ? { reasoningContent: reasoning } : {}),
      },
      ...(usage.inputTokens !== undefined || usage.outputTokens !== undefined ? { usage } : {}),
    };
  }

  #headers(accept: string): Record<string, string> {
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      accept,
    };
  }

  #redact(value: string): string {
    let result = value;
    for (const secret of [this.#apiKey, encodeURIComponent(this.#apiKey)]) {
      if (secret) result = result.replaceAll(secret, "[REDACTED]");
    }
    return result;
  }
}

export function normalizeAnthropicBaseUrl(value: string, allowInsecureHttp = false): string {
  const source = value.trim();
  const url = new URL(source);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Anthropic Base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Anthropic Base URL must not contain credentials");
  if (url.search || url.hash) throw new Error("Anthropic Base URL must not contain a query or fragment");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname) && !allowInsecureHttp) {
    throw new Error("Remote Anthropic Base URLs must use HTTPS unless insecure HTTP is explicitly enabled");
  }
  let pathname = url.pathname.replace(/\/+$/u, "");
  if (!pathname) pathname = "/v1";
  url.pathname = pathname;
  return url.toString().replace(/\/+$/u, "");
}

function anthropicModelCapabilities(): ProviderModelCapabilities {
  return {
    image_input: {
      status: "supported",
      mime_types: ["image/png", "image/jpeg", "image/webp"],
      detail_levels: ["low", "high"],
      max_images: 4,
    },
  };
}

async function toAnthropicMessages(
  messages: readonly AgentMessage[],
  resolveAttachment: ProviderRequest["resolveAttachment"],
): Promise<AnthropicMessage[]> {
  const result: AnthropicMessage[] = [];
  const attachmentCache = new Map<string, Promise<ProviderResolvedAttachment>>();
  const append = (role: AnthropicRole, blocks: Array<Record<string, unknown>>): void => {
    if (blocks.length === 0) return;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else result.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === "user") {
      append("user", await toAnthropicUserContent(message.content, resolveAttachment, attachmentCache));
      continue;
    }
    if (message.role === "tool") {
      append("user", [{
        type: "tool_result",
        tool_use_id: message.callId,
        content: message.content,
      }]);
      continue;
    }
    const blocks: Array<Record<string, unknown>> = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseToolInput(call.arguments),
      });
    }
    append("assistant", blocks);
  }
  return result;
}

async function toAnthropicUserContent(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  resolveAttachment: ProviderRequest["resolveAttachment"],
  cache: Map<string, Promise<ProviderResolvedAttachment>>,
): Promise<Array<Record<string, unknown>>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const attachment = await resolveImagePart(part, resolveAttachment, cache);
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: Buffer.from(attachment.bytes).toString("base64"),
      },
    });
  }
  return blocks;
}

async function resolveImagePart(
  part: Extract<ContentPart, { type: "image" }>,
  resolveAttachment: ProviderRequest["resolveAttachment"],
  cache: Map<string, Promise<ProviderResolvedAttachment>>,
): Promise<ProviderResolvedAttachment> {
  if (!resolveAttachment) throw new Error("Anthropic image input requires an attachment resolver");
  let pending = cache.get(part.attachmentId);
  if (!pending) {
    pending = resolveAttachment(part.attachmentId);
    cache.set(part.attachmentId, pending);
  }
  const attachment = await pending;
  if (attachment.id !== part.attachmentId || attachment.mimeType !== part.mimeType) {
    throw new Error("Anthropic attachment metadata does not match the requested image");
  }
  if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength < 1) {
    throw new Error("Anthropic attachment resolver returned invalid image bytes");
  }
  return attachment;
}

function parseToolInput(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}") as unknown;
  } catch (error) {
    throw new Error("Anthropic tool call history contains invalid JSON arguments", { cause: error });
  }
  const input = asRecord(parsed);
  if (!input) throw new Error("Anthropic tool call arguments must be a JSON object");
  return input;
}

async function readBoundedResponseText(
  response: Response,
  limit: number,
  overflowMessage: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(overflowMessage);
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

function parseJsonObject(
  source: string,
  redact: (value: string) => string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(source) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error(`${label} must be a JSON object`);
    return record;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a JSON object`) throw error;
    throw new Error(`Invalid ${label} JSON: ${redact(source.slice(0, 500))}`, { cause: error });
  }
}

function streamIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new Error("Anthropic stream contains an invalid content block index");
  }
  return value as number;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length <= limit ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
