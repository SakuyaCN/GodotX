import { decodeSse } from "../sse.js";
import { randomUUID } from "node:crypto";
import { makeProviderHttpError, ProviderHttpError } from "./errors.js";
export { ProviderHttpError } from "./errors.js";
import {
  isReasoningEffort,
  MAX_REASONING_MODEL,
  REASONING_EFFORTS,
} from "../model-options.js";
import type {
  AgentMessage,
  ContentPart,
  GeneratedImage,
  GeneratedImageMimeType,
  ImageEditRequest,
  ImageGenerationCapabilities,
  ImageGenerationRequest,
  ImageOutputFormat,
  ModelProvider,
  ProviderModel,
  ProviderModelCapabilities,
  ProviderRequest,
  ProviderResolvedAttachment,
  ProviderTurnResult,
  ProviderUsage,
  ToolCall,
  ToolSchema,
} from "./types.js";

const OPENAI_COMPATIBLE_IMAGE_CAPABILITIES: ImageGenerationCapabilities = {
  defaultModel: "gpt-image-2",
  models: ["gpt-image-2"],
  sizes: ["1024x1024", "1536x1024", "1024x1536"],
  qualities: ["auto", "low", "medium", "high"],
  backgrounds: ["auto", "opaque", "transparent"],
  outputFormats: ["png", "jpeg", "webp"],
  maxPromptCharacters: 32_000,
};
const MAX_GENERATED_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 34 * 1024 * 1024;
const MAX_IMAGE_EDIT_INPUT_BYTES = 50 * 1024 * 1024;

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  mode?: "auto" | "responses" | "chat_completions";
  fetchImpl?: typeof fetch;
  modelCapabilities?: (model: string) => ProviderModelCapabilities;
  chatCompletion?: {
    requestFields?: (request: ProviderRequest) => Record<string, unknown>;
    preserveReasoningContent?: boolean;
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #modelCapabilities: (model: string) => ProviderModelCapabilities;
  readonly #chatCompletionRequestFields: (request: ProviderRequest) => Record<string, unknown>;
  readonly #preserveChatReasoningContent: boolean;
  #mode: "auto" | "responses" | "chat_completions";
  readonly #resolvedModes = new Map<string, "responses" | "chat_completions">();

  constructor(options: OpenAICompatibleOptions) {
    this.#baseUrl = normalizeOpenAICompatibleBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#mode = options.mode ?? "auto";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#modelCapabilities = options.modelCapabilities ?? getOpenAICompatibleModelCapabilities;
    this.#chatCompletionRequestFields = options.chatCompletion?.requestFields ?? defaultChatReasoningFields;
    this.#preserveChatReasoningContent = options.chatCompletion?.preserveReasoningContent ?? false;
  }

  getModelCapabilities(model: string): ProviderModelCapabilities {
    return this.#modelCapabilities(model);
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    if (request.reasoningEffort !== undefined && !isReasoningEffort(request.reasoningEffort)) {
      throw new Error("Invalid reasoning effort");
    }
    const supportedEfforts = this.#modelCapabilities(request.model).reasoning?.efforts ?? [];
    if (request.reasoningEffort !== undefined && !supportedEfforts.includes(request.reasoningEffort)) {
      throw new Error(`Reasoning effort "${request.reasoningEffort}" is not supported by model "${request.model}"`);
    }
    const preparedRequest = withCachedAttachmentResolver(request);
    const mode = (this.#mode === "auto" ? this.#resolvedModes.get(request.model) : undefined) ?? this.#mode;
    if (mode === "responses" && this.#mode !== "auto") return this.#streamResponses(preparedRequest);
    if (mode === "chat_completions") return this.#streamChat(preparedRequest);

    try {
      const result = await this.#streamResponses(preparedRequest);
      this.#resolvedModes.set(request.model, "responses");
      return result;
    } catch (error) {
      if (!isEndpointCompatibilityError(error)) throw error;
      preparedRequest.onEvent({
        type: "fallback",
        from: "responses",
        to: "chat_completions",
        reason: error instanceof Error ? error.message : String(error),
      });
      const result = await this.#streamChat(preparedRequest);
      this.#resolvedModes.set(request.model, "chat_completions");
      return result;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) throw await this.#httpError(response);
    const text = await readResponseText(
      response,
      2_000_000,
      false,
      "Provider model list exceeds the 2 MB limit",
    );

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error("Provider returned invalid JSON for the model list", { cause: error });
    }
    const payloadObject = asObject(payload);
    if (
      (payloadObject?.error !== undefined && payloadObject.error !== null)
      || payloadObject?.type === "error"
    ) {
      throw makeProviderHttpError(response.status, this.#redact(text.slice(0, 2_000)));
    }
    const data = payloadObject?.data;
    if (!Array.isArray(data)) throw new Error("Provider model list must contain a data array");
    if (data.length > 5_000) throw new Error("Provider model list exceeds the 5000 item limit");

    const models = new Map<string, ProviderModel>();
    for (const rawModel of data) {
      const model = asObject(rawModel);
      const id = asString(model?.id)?.trim();
      if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) continue;
      const ownedBy = asString(model?.owned_by)?.trim();
      models.set(id, {
        id,
        ...(ownedBy ? { ownedBy } : {}),
        capabilities: this.#modelCapabilities(id),
      });
    }
    return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  getImageGenerationCapabilities(): ImageGenerationCapabilities {
    return {
      ...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES,
      models: [...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES.models],
      sizes: [...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES.sizes],
      qualities: [...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES.qualities],
      backgrounds: [...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES.backgrounds],
      outputFormats: [...OPENAI_COMPATIBLE_IMAGE_CAPABILITIES.outputFormats],
    };
  }

  async listImageModels(signal?: AbortSignal): Promise<string[]> {
    const models = await this.listModels(signal);
    return models.map((model) => model.id).filter(isLikelyImageGenerationModel);
  }

  async listImageEditModels(signal?: AbortSignal): Promise<string[]> {
    const models = await this.listModels(signal);
    return models.map((model) => model.id).filter(isLikelyImageEditModel);
  }

  async generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const { model, prompt, size, quality, background, outputFormat } = readImageRequestOptions(
      request,
      this.getImageGenerationCapabilities(),
    );

    const signal = imageRequestSignal(request.signal);
    const response = await this.#fetch(`${this.#baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      redirect: "error",
      signal,
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        output_format: outputFormat,
        ...(quality !== "auto" ? { quality } : {}),
        ...(background !== "auto" ? { background } : {}),
      }),
    });
    return this.#readImageResponse(response, signal);
  }

  async editImage(request: ImageEditRequest): Promise<GeneratedImage> {
    const { model, prompt, size, quality, background, outputFormat } = readImageRequestOptions(
      request,
      this.getImageGenerationCapabilities(),
    );
    const image = readImageEditSource(request.image);
    const inputFidelity = request.inputFidelity === undefined
      ? undefined
      : readSafeImageOption(request.inputFidelity, "input fidelity", ["low", "high"]);
    const body = new FormData();
    body.append("image", new Blob([image.bytes], { type: image.mimeType }), image.fileName);
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("size", size);
    body.append("output_format", outputFormat);
    if (quality !== "auto") body.append("quality", quality);
    if (background !== "auto") body.append("background", background);
    if (inputFidelity !== undefined && !isGptImage2Model(model)) {
      body.append("input_fidelity", inputFidelity);
    }

    const signal = imageRequestSignal(request.signal);
    const response = await this.#fetch(`${this.#baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal,
      body,
    });
    return this.#readImageResponse(response, signal);
  }

  async #readImageResponse(response: Response, signal: AbortSignal): Promise<GeneratedImage> {
    if (!response.ok) throw await this.#httpError(response);
    const responseText = await readResponseText(
      response,
      MAX_IMAGE_RESPONSE_BYTES,
      false,
      "Image generation response exceeds the 34 MiB limit",
    );
    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new Error("Image provider returned invalid JSON", { cause: error });
    }
    const payloadObject = asObject(payload);
    if (
      (payloadObject?.error !== undefined && payloadObject.error !== null)
      || payloadObject?.type === "error"
    ) {
      throw makeProviderHttpError(response.status, this.#redact(responseText.slice(0, 2_000)));
    }
    const data = payloadObject?.data;
    const first = Array.isArray(data) ? asObject(data[0]) : undefined;
    if (!first) throw new Error("Image provider returned no generated image");
    const revisedPrompt = asString(first.revised_prompt)?.trim();
    const encoded = asString(first.b64_json) ?? asString(first.base64) ?? asString(first.b64);
    if (encoded) {
      const bytes = decodeGeneratedImage(encoded);
      return {
        bytes,
        mimeType: detectGeneratedImageMimeType(bytes),
        ...(revisedPrompt ? { revisedPrompt } : {}),
      };
    }

    const remoteUrl = asString(first.url);
    if (!remoteUrl) throw new Error("Image provider returned neither Base64 image data nor a URL");
    const imageUrl = parseGeneratedImageUrl(remoteUrl);
    const imageResponse = await this.#fetch(imageUrl, {
      method: "GET",
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      redirect: "error",
      signal,
    });
    if (!imageResponse.ok) throw await this.#httpError(imageResponse);
    const bytes = await readResponseBytes(
      imageResponse,
      MAX_GENERATED_IMAGE_BYTES,
      "Generated image exceeds the 24 MiB limit",
    );
    return {
      bytes,
      mimeType: detectGeneratedImageMimeType(bytes),
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }

  async #post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      redirect: "error",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await this.#httpError(response);
    if (!response.body) throw new Error("Provider returned an empty response body");
    return response;
  }

  async #httpError(response: Response): Promise<ProviderHttpError> {
    const raw = await readResponseText(response, 2_000, true, "");
    return makeProviderHttpError(response.status, this.#redact(raw));
  }

  #redact(value: string): string {
    const withoutKey = this.#apiKey ? value.replaceAll(this.#apiKey, "[REDACTED]") : value;
    return withoutKey.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
  }

  async #streamResponses(request: ProviderRequest): Promise<ProviderTurnResult> {
    const response = await this.#post(
      "/responses",
      {
        model: request.model,
        instructions: request.systemPrompt,
        input: await toResponsesInput(request.messages, request.resolveAttachment),
        tools: request.tools.map(toResponsesTool),
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        store: false,
        ...(request.reasoningEffort
          ? { reasoning: { effort: request.reasoningEffort, summary: "auto" } }
          : {}),
      },
      request.signal,
    );

    let text = "";
    let usage: ProviderUsage | undefined;
    let completedResponse: Record<string, unknown> | undefined;
    const calls = new Map<string, ToolCall>();
    const itemToCall = new Map<string, string>();
    const summaryStates = new Map<string, Map<number, string>>();
    const rawReasoningStates = new Map<string, Map<number, string>>();
    const rawReasoningOrder: Array<{ scope: string; partIndex: number }> = [];
    const itemToReasoningOutput = new Map<string, number>();
    const syntheticPrefix = `synthetic_${randomUUID()}`;
    let lastAnonymousCallId: string | undefined;
    let sawReasoningSummary = false;

    const migrateReasoningScope = (
      states: Map<string, Map<number, string>>,
      fromScope: string,
      toScope: string,
    ): void => {
      if (fromScope === toScope) return;
      const fromParts = states.get(fromScope);
      if (!fromParts) return;
      const toParts = states.get(toScope) ?? new Map<number, string>();
      for (const [partIndex, sourceText] of fromParts) {
        const targetText = toParts.get(partIndex) ?? "";
        if (!targetText || sourceText.startsWith(targetText)) {
          toParts.set(partIndex, sourceText);
        }
      }
      states.set(toScope, toParts);
      states.delete(fromScope);
    };
    const registerReasoningItem = (itemId: string, outputIndex: number): void => {
      itemToReasoningOutput.set(itemId, outputIndex);
      const fromScope = `item:${itemId}`;
      const toScope = `output:${outputIndex}`;
      migrateReasoningScope(summaryStates, fromScope, toScope);
      migrateReasoningScope(rawReasoningStates, fromScope, toScope);
      for (const entry of rawReasoningOrder) {
        if (entry.scope === fromScope) entry.scope = toScope;
      }
    };
    const reasoningScope = (source: Record<string, unknown>): string => {
      const itemId = asString(source.item_id);
      const outputIndex = readNonNegativeIndex(source.output_index);
      if (outputIndex !== undefined) {
        if (itemId) registerReasoningItem(itemId, outputIndex);
        return `output:${outputIndex}`;
      }
      if (itemId) {
        const knownOutput = itemToReasoningOutput.get(itemId);
        return knownOutput !== undefined ? `output:${knownOutput}` : `item:${itemId}`;
      }
      return "output:0";
    };
    const reasoningPartIndex = (
      source: Record<string, unknown>,
      indexName: "summary_index" | "content_index",
    ): number => readNonNegativeIndex(source[indexName]) ?? 0;
    const updateReasoningState = (
      states: Map<string, Map<number, string>>,
      scope: string,
      partIndex: number,
      incoming: string,
      snapshot: boolean,
    ): string => {
      if (!incoming) return "";
      const parts = states.get(scope) ?? new Map<number, string>();
      const current = parts.get(partIndex) ?? "";
      const reconciled = reconcileReasoningText(current, incoming, snapshot);
      parts.set(partIndex, reconciled.text);
      states.set(scope, parts);
      return reconciled.delta;
    };
    const processReasoningSummary = (
      scope: string,
      partIndex: number,
      incoming: string,
      snapshot: boolean,
    ): void => {
      if (!incoming) return;
      sawReasoningSummary = true;
      const delta = updateReasoningState(summaryStates, scope, partIndex, incoming, snapshot);
      if (delta) request.onEvent({ type: "reasoning_delta", text: delta });
    };
    const processRawReasoning = (
      scope: string,
      partIndex: number,
      incoming: string,
      snapshot: boolean,
    ): void => {
      if (!incoming) return;
      const parts = rawReasoningStates.get(scope);
      if (!parts?.has(partIndex)) rawReasoningOrder.push({ scope, partIndex });
      updateReasoningState(rawReasoningStates, scope, partIndex, incoming, snapshot);
    };
    const processReasoningItem = (item: Record<string, unknown>, outputIndex: number): void => {
      const itemId = asString(item.id);
      if (itemId) registerReasoningItem(itemId, outputIndex);
      const scope = `output:${outputIndex}`;
      const summary = Array.isArray(item.summary) ? item.summary : [];
      for (const [summaryIndex, rawPart] of summary.entries()) {
        const part = asObject(rawPart);
        if (!part) continue;
        const partType = asString(part.type);
        if (partType && partType !== "summary_text") continue;
        processReasoningSummary(scope, summaryIndex, asString(part.text) ?? "", true);
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const [contentIndex, rawPart] of content.entries()) {
        const part = asObject(rawPart);
        if (!part) continue;
        const partType = asString(part.type);
        if (partType && partType !== "reasoning_text") continue;
        processRawReasoning(scope, contentIndex, asString(part.text) ?? "", true);
      }
    };

    for await (const message of decodeSse(response.body!)) {
      if (message.data === "[DONE]") break;
      const event = parseJson(message.data, (value) => this.#redact(value));
      const type = asString(event.type) ?? message.event;
      if (!type) continue;

      if (type === "response.output_text.delta") {
        const delta = asString(event.delta) ?? "";
        if (delta) {
          text += delta;
          request.onEvent({ type: "text_delta", text: delta });
        }
        continue;
      }

      if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        const delta = asString(event.delta) ?? "";
        const isSummary = type === "response.reasoning_summary_text.delta";
        const scope = reasoningScope(event);
        const partIndex = reasoningPartIndex(event, isSummary ? "summary_index" : "content_index");
        if (isSummary) processReasoningSummary(scope, partIndex, delta, false);
        else processRawReasoning(scope, partIndex, delta, false);
        continue;
      }

      if (
        type === "response.reasoning_summary_text.done" ||
        type === "response.reasoning_text.done"
      ) {
        const isSummary = type === "response.reasoning_summary_text.done";
        const scope = reasoningScope(event);
        const partIndex = reasoningPartIndex(event, isSummary ? "summary_index" : "content_index");
        const reasoningText = asString(event.text) ?? "";
        if (isSummary) processReasoningSummary(scope, partIndex, reasoningText, true);
        else processRawReasoning(scope, partIndex, reasoningText, true);
        continue;
      }

      if (
        type === "response.reasoning_summary_part.added" ||
        type === "response.reasoning_summary_part.done"
      ) {
        const part = asObject(event.part);
        if (!part || !asString(part.type) || part.type === "summary_text") {
          processReasoningSummary(
            reasoningScope(event),
            reasoningPartIndex(event, "summary_index"),
            asString(part?.text) ?? "",
            true,
          );
        }
        continue;
      }

      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = asObject(event.item);
        if (item?.type === "function_call") {
          const outputIndex = typeof event.output_index === "number" ? event.output_index : undefined;
          lastAnonymousCallId = upsertResponseToolCall(
            calls,
            itemToCall,
            item,
            syntheticPrefix,
            outputIndex !== undefined
              ? `${syntheticPrefix}_${outputIndex}`
              : type === "response.output_item.done"
                ? lastAnonymousCallId
                : undefined,
            );
        } else if (item?.type === "reasoning") {
          const outputIndex = readNonNegativeIndex(event.output_index) ?? 0;
          processReasoningItem(item, outputIndex);
        }
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        const itemId = asString(event.item_id);
        const outputIndex = typeof event.output_index === "number" ? event.output_index : undefined;
        const id =
          asString(event.call_id) ??
          (itemId ? itemToCall.get(itemId) : undefined) ??
          itemId ??
          (outputIndex !== undefined ? `${syntheticPrefix}_${outputIndex}` : lastAnonymousCallId) ??
          `${syntheticPrefix}_${calls.size}`;
        lastAnonymousCallId = id;
        const delta = asString(event.delta) ?? "";
        const current = calls.get(id) ?? { id, name: asString(event.name) ?? "", arguments: "" };
        current.arguments += delta;
        calls.set(id, current);
        request.onEvent({
          type: "tool_call_delta",
          id,
          ...(current.name ? { name: current.name } : {}),
          argumentsDelta: delta,
        });
        continue;
      }

      if (type === "response.completed") {
        completedResponse = asObject(event.response);
        usage = readResponsesUsage(asObject(completedResponse?.usage));
      }

      if (type === "error" || type === "response.failed") {
        const error = asObject(event.error) ?? asObject(asObject(event.response)?.error);
        throw new Error(this.#redact(asString(error?.message) ?? `Provider stream failed: ${message.data.slice(0, 2_000)}`));
      }
    }

    const output = Array.isArray(completedResponse?.output) ? completedResponse.output : [];
    for (const [outputIndex, rawItem] of output.entries()) {
      const item = asObject(rawItem);
      if (!item) continue;
      if (item.type === "function_call") {
        lastAnonymousCallId = upsertResponseToolCall(
          calls,
          itemToCall,
          item,
          syntheticPrefix,
          `${syntheticPrefix}_${outputIndex}`,
        );
      }
      if (item.type === "reasoning") processReasoningItem(item, outputIndex);
      if (!text && item.type === "message") text += readResponseMessageText(item);
    }
    if (!sawReasoningSummary) {
      const emittedRawParts = new Set<string>();
      for (const { scope, partIndex } of rawReasoningOrder) {
        const key = `${scope}\u0000${partIndex}`;
        if (emittedRawParts.has(key)) continue;
        emittedRawParts.add(key);
        const rawReasoning = rawReasoningStates.get(scope)?.get(partIndex) ?? "";
        if (rawReasoning) request.onEvent({ type: "reasoning_delta", text: rawReasoning });
      }
    }
    if (usage) request.onEvent({ type: "usage", usage });

    return {
      message: { role: "assistant", content: text, toolCalls: [...calls.values()] },
      ...(usage ? { usage } : {}),
    };
  }

  async #streamChat(request: ProviderRequest): Promise<ProviderTurnResult> {
    const response = await this.#post(
      "/chat/completions",
      {
        model: request.model,
        messages: await toChatMessages(
          request.systemPrompt,
          request.messages,
          request.resolveAttachment,
          this.#preserveChatReasoningContent,
        ),
        tools: request.tools.map(toChatTool),
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        ...this.#chatCompletionRequestFields(request),
      },
      request.signal,
    );

    let text = "";
    let reasoningText = "";
    let usage: ProviderUsage | undefined;
    const calls = new Map<number, ToolCall>();
    let lastToolIndex = -1;
    const syntheticPrefix = `synthetic_${randomUUID()}`;

    for await (const message of decodeSse(response.body!)) {
      if (message.data === "[DONE]") break;
      const event = parseJson(message.data, (value) => this.#redact(value));
      const streamError = asObject(event.error);
      if (streamError || event.type === "error") {
        throw new Error(
          this.#redact(asString(streamError?.message) ?? `Provider stream failed: ${message.data.slice(0, 2_000)}`),
        );
      }
      const eventUsage = readChatUsage(asObject(event.usage));
      if (eventUsage) usage = eventUsage;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const rawChoice of choices) {
        const choice = asObject(rawChoice);
        const delta = asObject(choice?.delta);
        if (!delta) continue;
        const content = asString(delta.content) ?? "";
        if (content) {
          text += content;
          request.onEvent({ type: "text_delta", text: content });
        }
        const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning) ?? "";
        if (reasoning) {
          const reconciled = reconcileReasoningText(reasoningText, reasoning, false);
          reasoningText = reconciled.text;
          if (reconciled.delta) request.onEvent({ type: "reasoning_delta", text: reconciled.delta });
        }
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawCall of toolCalls) {
          const call = asObject(rawCall);
          if (!call) continue;
          const fn = asObject(call.function);
          const incomingId = asString(call.id);
          const existingIndex = incomingId
            ? [...calls.entries()].find(([, existing]) => existing.id === incomingId)?.[0]
            : undefined;
          const startsCall = Boolean(incomingId || asString(fn?.name));
          const index =
            typeof call.index === "number"
              ? call.index
              : existingIndex ?? (startsCall || lastToolIndex < 0 ? calls.size : lastToolIndex);
          lastToolIndex = index;
          const current = calls.get(index) ?? {
            id: incomingId ?? `${syntheticPrefix}_${index}`,
            name: asString(fn?.name) ?? "",
            arguments: "",
          };
          if (asString(call.id)) current.id = asString(call.id)!;
          if (asString(fn?.name)) current.name = asString(fn?.name)!;
          const argumentsDelta = asString(fn?.arguments) ?? "";
          current.arguments += argumentsDelta;
          calls.set(index, current);
          request.onEvent({
            type: "tool_call_delta",
            id: current.id,
            ...(current.name ? { name: current.name } : {}),
            argumentsDelta,
          });
        }
      }
    }
    if (usage) request.onEvent({ type: "usage", usage });
    return {
      message: {
        role: "assistant",
        content: text,
        toolCalls: [...calls.values()],
        ...(this.#preserveChatReasoningContent && reasoningText && calls.size > 0
          ? { reasoningContent: reasoningText }
          : {}),
      },
      ...(usage ? { usage } : {}),
    };
  }
}

function toResponsesTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function toChatTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

async function toResponsesInput(
  messages: AgentMessage[],
  resolveAttachment: ProviderRequest["resolveAttachment"],
): Promise<unknown[]> {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        role: "user",
        content: await toResponsesUserContent(message.content, resolveAttachment),
      });
    }
    if (message.role === "assistant") {
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.callId, output: message.content });
    }
  }
  return input;
}

async function toChatMessages(
  systemPrompt: string,
  messages: AgentMessage[],
  resolveAttachment: ProviderRequest["resolveAttachment"],
  includeReasoningContent: boolean,
): Promise<unknown[]> {
  const result: unknown[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: message.content || null,
        ...(includeReasoningContent && message.reasoningContent
          ? { reasoning_content: message.reasoningContent }
          : {}),
        ...(message.toolCalls.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
    } else if (message.role === "tool") {
      result.push({ role: "tool", tool_call_id: message.callId, content: message.content });
    } else {
      result.push({ role: "user", content: await toChatUserContent(message.content, resolveAttachment) });
    }
  }
  return result;
}

function defaultChatReasoningFields(request: ProviderRequest): Record<string, unknown> {
  return request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {};
}

async function toResponsesUserContent(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  resolveAttachment: ProviderRequest["resolveAttachment"],
): Promise<unknown> {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }
    const attachment = await resolveImagePart(part, resolveAttachment);
    parts.push({
      type: "input_image",
      image_url: attachmentDataUrl(attachment),
      detail: part.detail,
    });
  }
  return parts;
}

async function toChatUserContent(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  resolveAttachment: ProviderRequest["resolveAttachment"],
): Promise<unknown> {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    const attachment = await resolveImagePart(part, resolveAttachment);
    parts.push({
      type: "image_url",
      image_url: { url: attachmentDataUrl(attachment), detail: part.detail },
    });
  }
  return parts;
}

async function resolveImagePart(
  part: Extract<ContentPart, { type: "image" }>,
  resolveAttachment: ProviderRequest["resolveAttachment"],
): Promise<ProviderResolvedAttachment> {
  if (!resolveAttachment) throw new Error(`No attachment resolver is available for image ${part.attachmentId}`);
  const attachment = await resolveAttachment(part.attachmentId);
  if (attachment.id !== part.attachmentId) throw new Error("Attachment resolver returned a mismatched id");
  if (attachment.mimeType !== part.mimeType) throw new Error("Attachment resolver returned a mismatched MIME type");
  if (attachment.bytes.byteLength !== attachment.byteSize || attachment.byteSize < 1) {
    throw new Error("Attachment resolver returned an invalid byte size");
  }
  return attachment;
}

function attachmentDataUrl(attachment: ProviderResolvedAttachment): string {
  return `data:${attachment.mimeType};base64,${Buffer.from(attachment.bytes).toString("base64")}`;
}

function withCachedAttachmentResolver(request: ProviderRequest): ProviderRequest {
  if (!request.resolveAttachment) return request;
  const resolve = request.resolveAttachment;
  const cache = new Map<string, Promise<ProviderResolvedAttachment>>();
  return {
    ...request,
    resolveAttachment: (attachmentId) => {
      const current = cache.get(attachmentId);
      if (current) return current;
      const pending = resolve(attachmentId);
      cache.set(attachmentId, pending);
      return pending;
    },
  };
}

function upsertResponseToolCall(
  calls: Map<string, ToolCall>,
  itemToCall: Map<string, string>,
  item: Record<string, unknown>,
  syntheticPrefix: string,
  anonymousFallback?: string,
): string {
  const itemId = asString(item.id);
  const callId = asString(item.call_id) ?? itemId ?? anonymousFallback ?? `${syntheticPrefix}_${calls.size}`;
  if (itemId) itemToCall.set(itemId, callId);
  const existing = calls.get(callId);
  calls.set(callId, {
    id: callId,
    name: asString(item.name) ?? existing?.name ?? "",
    arguments: asString(item.arguments) ?? existing?.arguments ?? "",
  });
  return callId;
}

function readResponseMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => asObject(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => asString(part.text) ?? "")
    .join("");
}

function readResponsesUsage(raw: Record<string, unknown> | undefined): ProviderUsage | undefined {
  if (!raw) return undefined;
  return compactUsage(raw.input_tokens, raw.output_tokens, raw.total_tokens);
}

function readChatUsage(raw: Record<string, unknown> | undefined): ProviderUsage | undefined {
  if (!raw) return undefined;
  return compactUsage(raw.prompt_tokens, raw.completion_tokens, raw.total_tokens);
}

function compactUsage(input: unknown, output: unknown, total: unknown): ProviderUsage | undefined {
  const usage: ProviderUsage = {};
  if (typeof input === "number") usage.inputTokens = input;
  if (typeof output === "number") usage.outputTokens = output;
  if (typeof total === "number") usage.totalTokens = total;
  return Object.keys(usage).length ? usage : undefined;
}

function parseJson(data: string, redact: (value: string) => string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid SSE JSON: ${redact(data.slice(0, 500))}`, { cause: error });
  }
}

function reconcileReasoningText(
  current: string,
  incoming: string,
  snapshot: boolean,
): { text: string; delta: string } {
  if (!incoming) return { text: current, delta: "" };
  if (!current) return { text: incoming, delta: incoming };
  if (incoming === current || (snapshot && current.startsWith(incoming))) {
    return { text: current, delta: "" };
  }
  if (incoming.startsWith(current)) {
    return { text: incoming, delta: incoming.slice(current.length) };
  }
  if (snapshot) return { text: current, delta: "" };
  return { text: current + incoming, delta: incoming };
}

function readNonNegativeIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  truncate: boolean,
  limitMessage: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        if (!truncate) {
          await reader.cancel();
          throw new Error(limitMessage);
        }
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        await reader.cancel();
        return text + decoder.decode();
      }
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readResponseBytes(response: Response, maxBytes: number, limitMessage: string): Promise<Uint8Array> {
  if (!response.body) throw new Error("Image provider returned an empty image body");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(limitMessage);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(limitMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readSafeImageOption(
  value: string,
  field: string,
  allowed: readonly string[],
  requireKnown = true,
): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error(`${field} must be a non-empty safe string`);
  }
  if (requireKnown && !allowed.includes(clean)) throw new Error(`Unsupported image ${field}: ${clean}`);
  return clean;
}

function readImageRequestOptions(
  request: ImageGenerationRequest,
  capabilities: ImageGenerationCapabilities,
): {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: ImageOutputFormat;
} {
  const model = readSafeImageOption(request.model, "model", capabilities.models, false);
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > capabilities.maxPromptCharacters || prompt.includes("\0")) {
    throw new Error(`Image prompt must contain 1-${capabilities.maxPromptCharacters} safe characters`);
  }
  const size = readSafeImageSize(
    request.size ?? capabilities.sizes[0]!,
    model,
    capabilities.sizes,
  );
  const quality = readSafeImageOption(
    request.quality ?? capabilities.qualities[0]!,
    "quality",
    capabilities.qualities,
  );
  const background = readSafeImageOption(
    request.background ?? capabilities.backgrounds[0]!,
    "background",
    capabilities.backgrounds,
  );
  const outputFormat = request.outputFormat ?? capabilities.outputFormats[0]!;
  if (!capabilities.outputFormats.includes(outputFormat)) {
    throw new Error(`Unsupported image output format: ${outputFormat}`);
  }
  if (outputFormat === "jpeg" && background === "transparent") {
    throw new Error("Transparent backgrounds require PNG or WebP output");
  }
  return { model, prompt, size, quality, background, outputFormat };
}

function imageRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(180_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function readImageEditSource(image: ImageEditRequest["image"]): {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: GeneratedImageMimeType;
  fileName: string;
} {
  if (!(image?.bytes instanceof Uint8Array)) {
    throw new Error("Image edit source must contain binary image data");
  }
  if (!image.bytes.byteLength || image.bytes.byteLength > MAX_IMAGE_EDIT_INPUT_BYTES) {
    throw new Error("Image edit source must contain 1 byte to 50 MiB of image data");
  }
  if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg" && image.mimeType !== "image/webp") {
    throw new Error("Image edit source must use PNG, JPEG, or WebP");
  }
  let detectedMimeType: GeneratedImageMimeType;
  try {
    detectedMimeType = detectGeneratedImageMimeType(image.bytes);
  } catch {
    throw new Error("Image edit source must contain a valid PNG, JPEG, or WebP image");
  }
  if (detectedMimeType !== image.mimeType) {
    throw new Error("Image edit source MIME type does not match its image data");
  }
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
  return {
    bytes: new Uint8Array(image.bytes),
    mimeType: image.mimeType,
    fileName: `image.${extension}`,
  };
}

function readSafeImageSize(value: string, model: string, allowed: readonly string[]): string {
  const clean = readSafeImageOption(value, "size", allowed, false);
  if (allowed.includes(clean)) return clean;
  if (supportsFlexibleGptImageSize(model) && isValidFlexibleGptImageSize(clean)) return clean;
  throw new Error(`Unsupported image size: ${clean}`);
}

function supportsFlexibleGptImageSize(model: string): boolean {
  return isGptImage2Model(model);
}

function isGptImage2Model(model: string): boolean {
  return /^gpt[-_.]?image[-_.]?2(?:[-_.]|$)/iu.test(model.trim());
}

function isValidFlexibleGptImageSize(value: string): boolean {
  const match = /^(\d{2,4})x(\d{2,4})$/u.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  const shortest = Math.min(width, height);
  const longest = Math.max(width, height);
  const pixels = width * height;
  return (
    longest <= 3840
    && width % 16 === 0
    && height % 16 === 0
    && longest / shortest <= 3
    && pixels >= 655_360
    && pixels <= 8_294_400
  );
}

function decodeGeneratedImage(value: string): Uint8Array {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const encoded = (comma >= 0 ? value.slice(comma + 1) : value).replace(/\s+/gu, "");
  if (
    !encoded ||
    encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    throw new Error("Image provider returned invalid or oversized Base64 image data");
  }
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Generated image exceeds the 24 MiB limit");
  }
  return bytes;
}

function detectGeneratedImageMimeType(bytes: Uint8Array): GeneratedImageMimeType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  throw new Error("Image provider returned an unsupported or malformed image");
}

function parseGeneratedImageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Generated image URLs must use HTTPS without embedded credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/u.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname) ||
    hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")
  ) {
    throw new Error("Generated image URL points to a private or loopback host");
  }
  return url;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isEndpointCompatibilityError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if ([404, 405, 501].includes(error.status)) return true;
  return (
    [400, 415, 422].includes(error.status) &&
    /(?:responses? endpoint|endpoint.*responses?).*(?:not supported|unsupported|unknown|not found)/i.test(error.message)
  );
}

export function getOpenAICompatibleModelCapabilities(modelId: string): ProviderModelCapabilities {
  const efforts = REASONING_EFFORTS.filter(
    (effort) => effort !== "max" || modelId.trim() === MAX_REASONING_MODEL,
  );
  return {
    reasoning: {
      efforts,
      default_effort: "low",
    },
    image_input: {
      status: inferImageInputStatus(modelId),
      mime_types: ["image/png", "image/jpeg", "image/webp"],
      detail_levels: ["low", "high"],
      max_images: 4,
    },
  };
}

function inferImageInputStatus(modelId: string): "supported" | "unknown" {
  const normalized = modelId.trim().toLowerCase();
  return /(?:^|[\/_-])(?:gpt-5(?:\.|-|$)|gpt-4(?:o|\.1)(?:-|$)|vision(?:-|$))/u.test(normalized) ||
    normalized === MAX_REASONING_MODEL
    ? "supported"
    : "unknown";
}

export function isLikelyImageGenerationModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    /^(?:gpt|chatgpt)[-_.]?image(?:[-_.]|$)/u.test(normalized) ||
    /^dall[-_.]?e(?:[-_.]|$)/u.test(normalized) ||
    /(?:^|[-_/])(?:imagen|flux|recraft|seedream|imagegen)(?:[-_/]|$)/u.test(normalized)
  );
}

export function isLikelyImageEditModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return /^gpt[-_.]?image(?:[-_.]|$)/u.test(normalized);
}

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider Base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Provider Base URL must not contain credentials");
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error("Provider Base URL must not contain a query or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Remote Provider Base URLs must use HTTPS");
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
