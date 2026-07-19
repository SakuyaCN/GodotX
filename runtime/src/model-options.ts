// OpenAI-compatible model policy. The provider adapter owns these values; AgentRuntime does not.
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MAX_REASONING_MODEL = "gpt-5.6-sol";

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function supportsReasoningEffort(model: string, effort: ReasoningEffort): boolean {
  return effort !== "max" || model.trim() === MAX_REASONING_MODEL;
}
