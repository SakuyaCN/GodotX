import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultProviderRegistry,
  DEEPSEEK_PROVIDER_DEFINITION,
  DEEPSEEK_PROVIDER_ID,
  OPENCODE_ZEN_PROVIDER_DEFINITION,
  OPENCODE_ZEN_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ProviderConfigurationError,
  ProviderRegistry,
} from "../src/provider/registry.js";
import { DeepSeekProvider } from "../src/provider/deepseek.js";
import { OpenCodeZenProvider } from "../src/provider/opencode-zen.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";

test("default provider registry publishes and creates the built-in providers", () => {
  const registry = createDefaultProviderRegistry();

  assert.deepEqual(registry.definitions().map((definition) => definition.id), [
    OPENAI_COMPATIBLE_PROVIDER_ID,
    DEEPSEEK_PROVIDER_ID,
    OPENCODE_ZEN_PROVIDER_ID,
  ]);
  assert.equal(
    OPENAI_COMPATIBLE_PROVIDER_DEFINITION.configSchema.find((field) => field.key === "api_key")?.input,
    "secret",
  );
  assert.equal(OPENAI_COMPATIBLE_PROVIDER_DEFINITION.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(
    OPENAI_COMPATIBLE_PROVIDER_DEFINITION.configSchema.find((field) => field.key === "base_url"),
    {
      key: "base_url",
      label: "Base URL",
      input: "url",
      required: true,
      defaultValue: "https://ptai.cc/v1",
      description: "HTTPS API root, or an HTTP loopback address for a local provider.",
    },
  );
  assert.ok(
    registry.create(OPENAI_COMPATIBLE_PROVIDER_ID, {
      base_url: "https://models.example/v1/",
      api_key: "test-key",
    }) instanceof OpenAICompatibleProvider,
  );
  assert.equal(DEEPSEEK_PROVIDER_DEFINITION.defaultModel, "deepseek-v4-flash");
  assert.deepEqual(DEEPSEEK_PROVIDER_DEFINITION.configSchema, [
    {
      key: "api_key",
      label: "API key",
      input: "secret",
      required: true,
    },
  ]);
  assert.ok(
    registry.create(DEEPSEEK_PROVIDER_ID, { api_key: "test-deepseek-key" }) instanceof DeepSeekProvider,
  );
  assert.equal(OPENCODE_ZEN_PROVIDER_DEFINITION.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(OPENCODE_ZEN_PROVIDER_DEFINITION.configSchema, [
    {
      key: "api_key",
      label: "API key",
      input: "secret",
      required: true,
    },
  ]);
  assert.ok(
    registry.create(OPENCODE_ZEN_PROVIDER_ID, { api_key: "test-zen-key" }) instanceof OpenCodeZenProvider,
  );
});

test("provider config validation normalizes values and reports safe field issues", () => {
  const registry = createDefaultProviderRegistry();
  assert.deepEqual(
    registry.validateConfig(OPENAI_COMPATIBLE_PROVIDER_ID, {
      base_url: " https://models.example/v1/ ",
      api_key: "test-key",
      model: "ignored-runtime-setting",
    }),
    {
      ok: true,
      value: {
        base_url: "https://models.example/v1",
        api_key: "test-key",
        api_mode: "auto",
      },
    },
  );

  const invalid = registry.validateConfig(OPENAI_COMPATIBLE_PROVIDER_ID, {
    base_url: "http://models.example/v1",
    api_key: "",
    api_mode: "legacy",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.deepEqual(invalid.issues.map((issue) => issue.field), ["base_url", "api_key", "api_mode"]);
    assert.doesNotMatch(JSON.stringify(invalid.issues), /test-secret/i);
  }
  assert.throws(
    () => registry.create(OPENAI_COMPATIBLE_PROVIDER_ID, {
      base_url: "https://models.example/v1",
      api_key: "",
    }),
    ProviderConfigurationError,
  );

  assert.deepEqual(
    registry.validateConfig(DEEPSEEK_PROVIDER_ID, {
      api_key: " test-deepseek-key ",
      base_url: "https://attacker.invalid",
    }),
    { ok: true, value: { api_key: "test-deepseek-key" } },
  );
  assert.throws(
    () => registry.create(DEEPSEEK_PROVIDER_ID, { api_key: "  " }),
    ProviderConfigurationError,
  );

  assert.deepEqual(
    registry.validateConfig(OPENCODE_ZEN_PROVIDER_ID, {
      api_key: " test-zen-key ",
      base_url: "https://attacker.invalid",
    }),
    { ok: true, value: { api_key: "test-zen-key" } },
  );
  assert.throws(
    () => registry.create(OPENCODE_ZEN_PROVIDER_ID, { api_key: "  " }),
    ProviderConfigurationError,
  );
});

test("provider registry rejects duplicate and unknown providers", () => {
  const registry = new ProviderRegistry([OPENAI_COMPATIBLE_PROVIDER_DEFINITION]);
  assert.throws(() => registry.register(OPENAI_COMPATIBLE_PROVIDER_DEFINITION), /already registered/);
  assert.throws(() => registry.create("missing", {}), /Unknown provider/);
  assert.throws(
    () => registry.register({ ...OPENAI_COMPATIBLE_PROVIDER_DEFINITION, id: "missing-default", defaultModel: "" }),
    /needs a default model/,
  );
});
