import {
  normalizeOpenAICompatibleBaseUrl,
  OpenAICompatibleProvider,
} from "./openai-compatible.js";
import {
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekProvider,
} from "./deepseek.js";
import {
  OPENCODE_ZEN_DEFAULT_MODEL,
  OpenCodeZenProvider,
} from "./opencode-zen.js";
import type { ModelProvider } from "./types.js";

export type ProviderConfig = Readonly<Record<string, unknown>>;

export interface ProviderConfigOption {
  value: string;
  label: string;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  input: "text" | "url" | "secret" | "select";
  required: boolean;
  description?: string;
  defaultValue?: string;
  options?: readonly ProviderConfigOption[];
}

export interface ProviderConfigIssue {
  field: string;
  message: string;
}

export type ProviderConfigValidationResult =
  | { ok: true; value: ProviderConfig }
  | { ok: false; issues: readonly ProviderConfigIssue[] };

export interface ProviderDefinition {
  id: string;
  displayName: string;
  defaultModel: string;
  configSchema: readonly ProviderConfigField[];
  validateConfig(config: unknown): ProviderConfigValidationResult;
  create(config: unknown): ModelProvider;
}

export class ProviderConfigurationError extends Error {
  readonly providerId: string;
  readonly issues: readonly ProviderConfigIssue[];

  constructor(providerId: string, issues: readonly ProviderConfigIssue[]) {
    const details = issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    super(`Invalid configuration for provider "${providerId}": ${details}`);
    this.name = "ProviderConfigurationError";
    this.providerId = providerId;
    this.issues = issues;
  }
}

export class ProviderRegistry {
  readonly #definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ProviderDefinition): this {
    validateDefinition(definition);
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Provider "${definition.id}" is already registered`);
    }
    this.#definitions.set(definition.id, definition);
    return this;
  }

  has(providerId: string): boolean {
    return this.#definitions.has(providerId);
  }

  get(providerId: string): ProviderDefinition | undefined {
    return this.#definitions.get(providerId);
  }

  require(providerId: string): ProviderDefinition {
    const definition = this.get(providerId);
    if (!definition) throw new Error(`Unknown provider: ${providerId}`);
    return definition;
  }

  definitions(): ProviderDefinition[] {
    return [...this.#definitions.values()];
  }

  validateConfig(providerId: string, config: unknown): ProviderConfigValidationResult {
    return this.require(providerId).validateConfig(config);
  }

  create(providerId: string, config: unknown): ModelProvider {
    return this.require(providerId).create(config);
  }
}

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const OPENCODE_ZEN_PROVIDER_ID = "opencode-zen";

export const OPENAI_COMPATIBLE_PROVIDER_DEFINITION: ProviderDefinition = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  displayName: "OpenAI-compatible",
  defaultModel: "gpt-5.6-sol",
  configSchema: [
    {
      key: "base_url",
      label: "Base URL",
      input: "url",
      required: true,
      defaultValue: "https://ptai.cc/v1",
      description: "HTTPS API root, or an HTTP loopback address for a local provider.",
    },
    {
      key: "api_key",
      label: "API key",
      input: "secret",
      required: true,
    },
    {
      key: "api_mode",
      label: "API mode",
      input: "select",
      required: false,
      defaultValue: "auto",
      options: [
        { value: "auto", label: "Auto" },
        { value: "responses", label: "Responses" },
        { value: "chat_completions", label: "Chat Completions" },
      ],
    },
  ],
  validateConfig: validateOpenAICompatibleProviderConfig,
  create(config: unknown): ModelProvider {
    const result = validateOpenAICompatibleProviderConfig(config);
    if (!result.ok) throw new ProviderConfigurationError(OPENAI_COMPATIBLE_PROVIDER_ID, result.issues);
    return new OpenAICompatibleProvider({
      baseUrl: result.value.base_url as string,
      apiKey: result.value.api_key as string,
      mode: result.value.api_mode as "auto" | "responses" | "chat_completions",
    });
  },
};

export const DEEPSEEK_PROVIDER_DEFINITION: ProviderDefinition = {
  id: DEEPSEEK_PROVIDER_ID,
  displayName: "DeepSeek",
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
  configSchema: [
    {
      key: "api_key",
      label: "API key",
      input: "secret",
      required: true,
    },
  ],
  validateConfig: validateDeepSeekProviderConfig,
  create(config: unknown): ModelProvider {
    const result = validateDeepSeekProviderConfig(config);
    if (!result.ok) throw new ProviderConfigurationError(DEEPSEEK_PROVIDER_ID, result.issues);
    return new DeepSeekProvider({ apiKey: result.value.api_key as string });
  },
};

export const OPENCODE_ZEN_PROVIDER_DEFINITION: ProviderDefinition = {
  id: OPENCODE_ZEN_PROVIDER_ID,
  displayName: "OpenCode Zen",
  defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
  configSchema: [
    {
      key: "api_key",
      label: "API key",
      input: "secret",
      required: true,
    },
  ],
  validateConfig: validateOpenCodeZenProviderConfig,
  create(config: unknown): ModelProvider {
    const result = validateOpenCodeZenProviderConfig(config);
    if (!result.ok) throw new ProviderConfigurationError(OPENCODE_ZEN_PROVIDER_ID, result.issues);
    return new OpenCodeZenProvider({ apiKey: result.value.api_key as string });
  },
};

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
    DEEPSEEK_PROVIDER_DEFINITION,
    OPENCODE_ZEN_PROVIDER_DEFINITION,
  ]);
}

export function validateDeepSeekProviderConfig(config: unknown): ProviderConfigValidationResult {
  if (!isRecord(config)) {
    return { ok: false, issues: [{ field: "$", message: "configuration must be an object" }] };
  }
  const apiKey = typeof config.api_key === "string" ? config.api_key.trim() : "";
  if (!apiKey) return { ok: false, issues: [{ field: "api_key", message: "is required" }] };
  return { ok: true, value: { api_key: apiKey } };
}

export function validateOpenCodeZenProviderConfig(config: unknown): ProviderConfigValidationResult {
  if (!isRecord(config)) {
    return { ok: false, issues: [{ field: "$", message: "configuration must be an object" }] };
  }
  const apiKey = typeof config.api_key === "string" ? config.api_key.trim() : "";
  if (!apiKey) return { ok: false, issues: [{ field: "api_key", message: "is required" }] };
  return { ok: true, value: { api_key: apiKey } };
}

export function validateOpenAICompatibleProviderConfig(
  config: unknown,
): ProviderConfigValidationResult {
  if (!isRecord(config)) {
    return { ok: false, issues: [{ field: "$", message: "configuration must be an object" }] };
  }

  const issues: ProviderConfigIssue[] = [];
  let baseUrl: string | undefined;
  if (typeof config.base_url !== "string" || !config.base_url.trim()) {
    issues.push({ field: "base_url", message: "is required" });
  } else {
    try {
      baseUrl = normalizeOpenAICompatibleBaseUrl(config.base_url);
    } catch (error) {
      issues.push({
        field: "base_url",
        message: error instanceof Error ? error.message : "is invalid",
      });
    }
  }

  const apiKey = typeof config.api_key === "string" ? config.api_key : undefined;
  if (!apiKey) issues.push({ field: "api_key", message: "is required" });

  const rawMode = config.api_mode ?? "auto";
  const modes = ["auto", "responses", "chat_completions"] as const;
  const mode = typeof rawMode === "string" && modes.includes(rawMode as (typeof modes)[number])
    ? (rawMode as (typeof modes)[number])
    : undefined;
  if (!mode) issues.push({ field: "api_mode", message: "must be auto, responses, or chat_completions" });

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      base_url: baseUrl!,
      api_key: apiKey!,
      api_mode: mode!,
    },
  };
}

function validateDefinition(definition: ProviderDefinition): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(definition.id)) {
    throw new Error(`Invalid provider id: ${definition.id}`);
  }
  if (!definition.displayName.trim()) throw new Error(`Provider "${definition.id}" needs a display name`);
  if (!definition.defaultModel.trim()) throw new Error(`Provider "${definition.id}" needs a default model`);
  const keys = new Set<string>();
  for (const field of definition.configSchema) {
    if (!field.key || keys.has(field.key)) {
      throw new Error(`Provider "${definition.id}" has an invalid or duplicate config field: ${field.key}`);
    }
    keys.add(field.key);
    if (field.input === "select" && (!field.options || field.options.length === 0)) {
      throw new Error(`Provider "${definition.id}" select field "${field.key}" needs options`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
