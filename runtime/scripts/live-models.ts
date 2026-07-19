import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";

const baseUrl = process.env.GODOTX_BASE_URL ?? process.env.GODETX_BASE_URL ?? "https://ptai.cc/v1";
const apiKey = process.env.GODOTX_API_KEY ?? process.env.GODETX_API_KEY;
const expectedModel = process.env.GODOTX_MODEL ?? process.env.GODETX_MODEL ?? "gpt-5.6-sol";

if (!apiKey) throw new Error("GODOTX_API_KEY is required");

const provider = new OpenAICompatibleProvider({ baseUrl, apiKey, mode: "auto" });
const models = await provider.listModels();
assert.ok(models.length > 0, "The provider returned no usable models");
if (expectedModel) {
  assert.ok(models.some((model) => model.id === expectedModel), `Expected model is not present: ${expectedModel}`);
}

process.stdout.write(
  `LIVE_MODELS_OK count=${models.length}${expectedModel ? ` selected=${expectedModel}` : ""}\n`,
);
