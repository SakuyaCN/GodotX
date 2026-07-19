import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  AgentMessage,
  ModelProvider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderRequest,
  ProviderTurnResult,
} from "./types.js";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_ZEN_MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENCODE_ZEN_DEFAULT_MODEL = "gpt-5.6-sol";

export type OpenCodeZenProtocol =
  | "responses"
  | "chat_completions"
  | "anthropic_messages"
  | "google_generate_content"
  | "unknown";

export interface OpenCodeZenProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface ZenModelMetadata {
  protocol: OpenCodeZenProtocol;
  displayName?: string;
  reasoningEfforts: string[];
  imageInput: boolean;
  toolCall: boolean;
  interleavedReasoning: boolean;
}

export class OpenCodeZenProvider implements ModelProvider {
  readonly #fetch: typeof fetch;
  readonly #responses: OpenAICompatibleProvider;
  readonly #chat: OpenAICompatibleProvider;
  readonly #interleavedChat: OpenAICompatibleProvider;
  readonly #metadata = createSnapshotMetadata();
  #metadataRefresh: Promise<void> | undefined;

  constructor(options: OpenCodeZenProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    const shared = {
      baseUrl: OPENCODE_ZEN_BASE_URL,
      apiKey: options.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      modelCapabilities: (model: string) => this.getModelCapabilities(model),
    };
    this.#responses = new OpenAICompatibleProvider({
      ...shared,
      mode: "responses",
    });
    this.#chat = new OpenAICompatibleProvider({
      ...shared,
      mode: "chat_completions",
      chatCompletion: { requestFields: openCodeZenChatRequestFields },
    });
    this.#interleavedChat = new OpenAICompatibleProvider({
      ...shared,
      mode: "chat_completions",
      chatCompletion: {
        preserveReasoningContent: true,
        requestFields: openCodeZenChatRequestFields,
      },
    });
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const metadataRefresh = this.#refreshMetadata(signal);
    const models = await this.#chat.listModels(signal);
    await metadataRefresh;
    return models.flatMap((model) => {
      const metadata = this.#metadata.get(normalizeModelId(model.id));
      if (!metadata || !isOpenCodeZenProtocolSupported(metadata.protocol) || !metadata.toolCall) return [];
      return [{
        ...model,
        ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
        capabilities: capabilitiesFromMetadata(metadata),
      }];
    });
  }

  getModelCapabilities(model: string): ProviderModelCapabilities {
    const metadata = this.#metadata.get(normalizeModelId(model));
    return metadata ? capabilitiesFromMetadata(metadata) : unknownImageCapabilities();
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    let metadata = this.#metadata.get(normalizeModelId(request.model));
    if (!metadata) {
      await this.#refreshMetadata(request.signal);
      metadata = this.#metadata.get(normalizeModelId(request.model));
    }
    if (!metadata) {
      throw new Error(`OpenCode Zen protocol metadata is unavailable for model "${request.model}"`);
    }
    if (!isOpenCodeZenProtocolSupported(metadata.protocol)) {
      throw new Error(
        `OpenCode Zen model "${request.model}" requires the unsupported ${metadata.protocol} protocol`,
      );
    }
    if (!metadata.toolCall) {
      throw new Error(`OpenCode Zen model "${request.model}" does not support tool calls`);
    }
    if (hasImageInput(request) && !metadata.imageInput) {
      throw new Error(`Model "${request.model}" does not support image input`);
    }
    const normalizedRequest = isDeepSeekZenModel(request.model)
      ? { ...request, messages: request.messages.map(toTextOnlyUserMessage) }
      : request;
    if (metadata.protocol === "responses") return this.#responses.streamTurn(normalizedRequest);
    return metadata.interleavedReasoning
      ? this.#interleavedChat.streamTurn(normalizedRequest)
      : this.#chat.streamTurn(normalizedRequest);
  }

  async #refreshMetadata(signal?: AbortSignal): Promise<void> {
    this.#metadataRefresh ??= this.#loadMetadata(signal);
    await this.#metadataRefresh;
  }

  async #loadMetadata(signal?: AbortSignal): Promise<void> {
    try {
      const timeoutSignal = AbortSignal.timeout(5_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await this.#fetch(OPENCODE_ZEN_MODELS_DEV_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: requestSignal,
      });
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > 10_000_000) return;
      const parsed = parseModelsDevMetadata(JSON.parse(text) as unknown);
      if (parsed.size === 0) return;
      for (const [model, metadata] of parsed) this.#metadata.set(model, metadata);
    } catch {
      // The embedded snapshot keeps Zen usable when the public metadata service is unavailable.
    }
  }
}

export function getOpenCodeZenProtocol(model: string): OpenCodeZenProtocol {
  return SNAPSHOT_METADATA.get(normalizeModelId(model))?.protocol ?? "unknown";
}

export function getOpenCodeZenModelCapabilities(model: string): ProviderModelCapabilities {
  const metadata = SNAPSHOT_METADATA.get(normalizeModelId(model));
  return metadata ? capabilitiesFromMetadata(metadata) : unknownImageCapabilities();
}

function parseModelsDevMetadata(payload: unknown): Map<string, ZenModelMetadata> {
  const root = asRecord(payload);
  const provider = asRecord(root?.opencode);
  const models = asRecord(provider?.models);
  if (!provider || !models) return new Map();
  const defaultPackage = asString(provider.npm);
  const parsed = new Map<string, ZenModelMetadata>();
  for (const [rawId, rawMetadata] of Object.entries(models)) {
    const id = normalizeModelId(rawId);
    const metadata = asRecord(rawMetadata);
    if (!id || !metadata) continue;
    const packageName = asString(asRecord(metadata.provider)?.npm) ?? defaultPackage;
    const protocol = protocolFromPackage(packageName);
    const modalities = asRecord(metadata.modalities);
    const inputModalities = Array.isArray(modalities?.input) ? modalities.input : [];
    const interleaved = asRecord(metadata.interleaved);
    const displayName = asString(metadata.name);
    parsed.set(id, {
      protocol,
      ...(displayName ? { displayName } : {}),
      reasoningEfforts: readReasoningEfforts(id, metadata.reasoning_options),
      imageInput: inputModalities.includes("image"),
      toolCall: metadata.tool_call === true,
      interleavedReasoning: typeof interleaved?.field === "string",
    });
  }
  return parsed;
}

function protocolFromPackage(packageName: string | undefined): OpenCodeZenProtocol {
  if (packageName === "@ai-sdk/openai") return "responses";
  if (packageName === "@ai-sdk/openai-compatible") return "chat_completions";
  if (packageName === "@ai-sdk/anthropic") return "anthropic_messages";
  if (packageName === "@ai-sdk/google") return "google_generate_content";
  return "unknown";
}

function isOpenCodeZenProtocolSupported(protocol: OpenCodeZenProtocol): boolean {
  return protocol === "responses" || protocol === "chat_completions";
}

function capabilitiesFromMetadata(metadata: ZenModelMetadata): ProviderModelCapabilities {
  return {
    ...(metadata.reasoningEfforts.length > 0
      ? {
          reasoning: {
            efforts: [...metadata.reasoningEfforts],
            default_effort: metadata.reasoningEfforts[0]!,
          },
        }
      : {}),
    image_input: metadata.imageInput
      ? {
          status: "supported",
          mime_types: ["image/png", "image/jpeg", "image/webp"],
          detail_levels: ["low", "high"],
          max_images: 4,
        }
      : {
          status: "unsupported",
          mime_types: [],
          detail_levels: [],
          max_images: 0,
        },
  };
}

function unknownImageCapabilities(): ProviderModelCapabilities {
  return {
    image_input: {
      status: "unknown",
      mime_types: [],
      detail_levels: [],
      max_images: 0,
    },
  };
}

function readReasoningEfforts(model: string, rawOptions: unknown): string[] {
  if (!Array.isArray(rawOptions)) return [];
  const efforts: string[] = [];
  for (const rawOption of rawOptions) {
    const option = asRecord(rawOption);
    if (option?.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const rawValue of option.values) {
      const value = asString(rawValue);
      if (!value || !["low", "medium", "high", "xhigh", "max"].includes(value)) continue;
      if (value === "max" && !allowsMaxReasoning(model)) continue;
      if (!efforts.includes(value)) efforts.push(value);
    }
  }
  return efforts;
}

function allowsMaxReasoning(model: string): boolean {
  return model === "gpt-5.6-sol" || model.startsWith("deepseek-v4-") || model === "glm-5.2";
}

function openCodeZenChatRequestFields(request: ProviderRequest): Record<string, unknown> {
  if (isDeepSeekZenModel(request.model)) {
    return {
      thinking: { type: "enabled" },
      reasoning_effort: request.reasoningEffort ?? "high",
    };
  }
  return request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {};
}

function isDeepSeekZenModel(model: string): boolean {
  return normalizeModelId(model).startsWith("deepseek-v4-");
}

function hasImageInput(request: ProviderRequest): boolean {
  return request.messages.some((message) => (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image")
  ));
}

function toTextOnlyUserMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "user" || typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  };
}

function createSnapshotMetadata(): Map<string, ZenModelMetadata> {
  return new Map([...SNAPSHOT_METADATA].map(([id, metadata]) => [id, {
    ...metadata,
    reasoningEfforts: [...metadata.reasoningEfforts],
  }]));
}

function snapshotMetadata(
  protocol: OpenCodeZenProtocol,
  ids: readonly string[],
  interleavedIds: ReadonlySet<string> = new Set(),
): Array<[string, ZenModelMetadata]> {
  return ids.map((id) => [id, {
    protocol,
    reasoningEfforts: snapshotReasoningEfforts(id),
    imageInput: snapshotSupportsImageInput(id),
    toolCall: true,
    interleavedReasoning: interleavedIds.has(id),
  }]);
}

function snapshotReasoningEfforts(model: string): string[] {
  if (model === "gpt-5.6-sol") return ["low", "medium", "high", "xhigh", "max"];
  if (model === "gpt-5.5-pro" || model === "gpt-5.4-pro") return ["medium", "high", "xhigh"];
  if (["gpt-5", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex", "gpt-5-nano"].includes(model)) {
    return ["low", "medium", "high"];
  }
  if (model.startsWith("gpt-")) return ["low", "medium", "high", "xhigh"];
  if (model === "grok-4.5") return ["low", "medium", "high"];
  if (isDeepSeekZenModel(model) || model === "glm-5.2") return ["high", "max"];
  if (model === "north-mini-code-free") return ["high"];
  return [];
}

function snapshotSupportsImageInput(model: string): boolean {
  if (model.startsWith("gpt-") && model !== "gpt-5.3-codex-spark") return true;
  if (model.startsWith("grok-")) return true;
  if (model === "minimax-m3" || model.startsWith("kimi-")) return true;
  return model === "mimo-v2.5-free";
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const SNAPSHOT_INTERLEAVED_CHAT_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash",
  "deepseek-v4-flash-free",
  "deepseek-v4-pro",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "mimo-v2.5-free",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

const SNAPSHOT_METADATA = new Map<string, ZenModelMetadata>([
  ...snapshotMetadata("responses", [
    "gpt-5",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5-codex",
    "gpt-5-nano",
    "grok-4.5",
  ]),
  ...snapshotMetadata("chat_completions", [
    "big-pickle",
    "deepseek-v4-flash",
    "deepseek-v4-flash-free",
    "deepseek-v4-pro",
    "glm-5",
    "glm-5.1",
    "glm-5.2",
    "grok-build-0.1",
    "hy3-free",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "mimo-v2.5-free",
    "minimax-m2.5",
    "minimax-m2.7",
    "minimax-m3",
    "nemotron-3-ultra-free",
    "north-mini-code-free",
  ], SNAPSHOT_INTERLEAVED_CHAT_MODELS),
  ...snapshotMetadata("anthropic_messages", [
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "qwen3.5-plus",
    "qwen3.6-plus",
  ]),
  ...snapshotMetadata("google_generate_content", [
    "gemini-3.1-pro",
    "gemini-3.5-flash",
    "gemini-3-flash",
  ]),
]);
