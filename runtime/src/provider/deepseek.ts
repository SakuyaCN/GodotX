import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  AgentMessage,
  ModelProvider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderRequest,
  ProviderTurnResult,
} from "./types.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export interface DeepSeekProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider implements ModelProvider {
  readonly #delegate: OpenAICompatibleProvider;

  constructor(options: DeepSeekProviderOptions) {
    this.#delegate = new OpenAICompatibleProvider({
      baseUrl: DEEPSEEK_BASE_URL,
      apiKey: options.apiKey,
      mode: "chat_completions",
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      modelCapabilities: getDeepSeekModelCapabilities,
      chatCompletion: {
        preserveReasoningContent: true,
        requestFields: deepSeekChatRequestFields,
      },
    });
  }

  listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    return this.#delegate.listModels(signal);
  }

  getModelCapabilities(model: string): ProviderModelCapabilities {
    return getDeepSeekModelCapabilities(model);
  }

  streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    if (hasImageInput(request)) {
      throw new Error(`Model "${request.model}" does not support image input`);
    }
    return this.#delegate.streamTurn({
      ...request,
      messages: request.messages.map(toDeepSeekMessage),
    });
  }
}

export function getDeepSeekModelCapabilities(model: string): ProviderModelCapabilities {
  const imageInput = {
    status: "unsupported" as const,
    mime_types: [],
    detail_levels: [],
    max_images: 0,
  };
  if (model.trim().toLowerCase() === "deepseek-chat") return { image_input: imageInput };
  return {
    reasoning: {
      efforts: ["high", "max"],
      default_effort: "high",
    },
    image_input: imageInput,
  };
}

function deepSeekChatRequestFields(request: ProviderRequest): Record<string, unknown> {
  if (request.model.trim().toLowerCase() === "deepseek-chat") {
    return { thinking: { type: "disabled" } };
  }
  return {
    thinking: { type: "enabled" },
    reasoning_effort: request.reasoningEffort ?? "high",
  };
}

function hasImageInput(request: ProviderRequest): boolean {
  return request.messages.some((message) => (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image")
  ));
}

function toDeepSeekMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "user" || typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  };
}
