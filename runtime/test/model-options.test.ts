import assert from "node:assert/strict";
import test from "node:test";
import {
  isReasoningEffort,
  MAX_REASONING_MODEL,
  REASONING_EFFORTS,
  supportsReasoningEffort,
} from "../src/model-options.js";

test("OpenAI-compatible reasoning efforts start at low and restrict max to GPT-5.6 Sol", () => {
  assert.deepEqual(REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(isReasoningEffort("none"), false);
  assert.equal(isReasoningEffort("minimal"), false);
  assert.equal(supportsReasoningEffort(MAX_REASONING_MODEL, "max"), true);
  assert.equal(supportsReasoningEffort("gpt-5.6-terra", "max"), false);
  assert.equal(supportsReasoningEffort("gpt-5.6-terra", "xhigh"), true);
});
