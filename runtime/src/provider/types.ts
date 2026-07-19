import type { ImageAnnotation } from "../image-annotations.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ImageDetail = "low" | "high";

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      attachmentId: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      detail: ImageDetail;
      annotations?: ImageAnnotation[];
    };

export type UserMessageContent = string | ContentPart[];

export type AgentMessage =
  | {
      role: "user";
      content: UserMessageContent;
      synthetic?: { kind: "tool_observation"; callId: string };
    }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      reasoningContent?: string;
    }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; id: string; name?: string; argumentsDelta: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "fallback"; from: string; to: string; reason: string };

export interface ProviderTurnResult {
  message: Extract<AgentMessage, { role: "assistant" }>;
  usage?: ProviderUsage;
}

export interface ProviderModel {
  id: string;
  displayName?: string;
  ownedBy?: string;
  capabilities?: ProviderModelCapabilities;
}

export interface ProviderReasoningCapabilities {
  efforts: string[];
  default_effort: string;
}

export interface ProviderModelCapabilities {
  reasoning?: ProviderReasoningCapabilities;
  image_input?: {
    status: "supported" | "unsupported" | "unknown";
    mime_types: Array<Extract<ContentPart, { type: "image" }>["mimeType"]>;
    detail_levels: ImageDetail[];
    max_images: number;
  };
}

export type GeneratedImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface ImageGenerationCapabilities {
  defaultModel: string;
  models: string[];
  sizes: string[];
  qualities: string[];
  backgrounds: string[];
  outputFormats: ImageOutputFormat[];
  maxPromptCharacters: number;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: ImageOutputFormat;
  signal?: AbortSignal;
}

export interface ImageEditRequest extends ImageGenerationRequest {
  image: {
    bytes: Uint8Array;
    mimeType: GeneratedImageMimeType;
  };
  inputFidelity?: "low" | "high";
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: GeneratedImageMimeType;
  revisedPrompt?: string;
}

export interface ProviderResolvedAttachment {
  id: string;
  mimeType: Extract<ContentPart, { type: "image" }>["mimeType"];
  bytes: Uint8Array;
  width: number;
  height: number;
  byteSize: number;
}

export interface ProviderRequest {
  model: string;
  reasoningEffort?: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
  resolveAttachment?: (attachmentId: string) => Promise<ProviderResolvedAttachment>;
  signal?: AbortSignal;
  onEvent: (event: ProviderStreamEvent) => void;
}

export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  getModelCapabilities?(model: string): ProviderModelCapabilities | undefined;
  getImageGenerationCapabilities?(): ImageGenerationCapabilities;
  listImageModels?(signal?: AbortSignal): Promise<string[]>;
  listImageEditModels?(signal?: AbortSignal): Promise<string[]>;
  generateImage?(request: ImageGenerationRequest): Promise<GeneratedImage>;
  editImage?(request: ImageEditRequest): Promise<GeneratedImage>;
  streamTurn(request: ProviderRequest): Promise<ProviderTurnResult>;
  dispose?(): void | Promise<void>;
}
