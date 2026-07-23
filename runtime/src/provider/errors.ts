export type ProviderErrorCategory = "authentication" | "billing" | "http";
export type ProviderFailureCode = "PROVIDER_AUTH_FAILED" | "PROVIDER_BILLING_FAILED";

export interface ProviderFailure {
  code: ProviderFailureCode;
  status?: number;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly category: ProviderErrorCategory,
    readonly providerErrorType?: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export function makeProviderHttpError(status: number, sanitizedBody: string): ProviderHttpError {
  const providerErrorType = readProviderErrorType(sanitizedBody);
  const category = providerErrorCategory(status, providerErrorType, sanitizedBody);
  const message = category === "billing"
    ? `HTTP ${status}: Provider account has insufficient balance`
    : `HTTP ${status}: ${sanitizedBody}`;
  return new ProviderHttpError(
    status,
    message,
    category,
    ...(providerErrorType ? [providerErrorType] : []),
  );
}

export function classifyProviderFailure(error: unknown): ProviderFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as Error & { status?: unknown; category?: unknown };
  const status = typeof candidate.status === "number" && Number.isInteger(candidate.status)
    ? candidate.status
    : undefined;
  if (candidate.category === "billing") {
    return { code: "PROVIDER_BILLING_FAILED", ...(status !== undefined ? { status } : {}) };
  }
  if (candidate.category === "authentication" || status === 401 || status === 403) {
    return { code: "PROVIDER_AUTH_FAILED", ...(status !== undefined ? { status } : {}) };
  }
  return undefined;
}

function providerErrorCategory(
  status: number,
  providerErrorType: string | undefined,
  body: string,
): ProviderErrorCategory {
  const normalizedType = providerErrorType?.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "") ?? "";
  const normalizedBody = body.toLowerCase();
  if (
    status === 402 ||
    normalizedType === "billingerror" ||
    normalizedType === "creditserror" ||
    normalizedType === "insufficientquota" ||
    normalizedType === "billinghardlimitreached" ||
    normalizedType === "creditbalancetoolow" ||
    normalizedBody.includes("insufficient balance") ||
    normalizedBody.includes("insufficient credits") ||
    normalizedBody.includes("billing hard limit")
  ) {
    return "billing";
  }
  return status === 401 || status === 403 ? "authentication" : "http";
}

function readProviderErrorType(body: string): string | undefined {
  try {
    const payload = asRecord(JSON.parse(body) as unknown);
    const nestedError = asRecord(payload?.error);
    const value = safeIdentifier(nestedError?.type) ?? safeIdentifier(nestedError?.code)
      ?? safeIdentifier(payload?.type) ?? safeIdentifier(payload?.code);
    return value;
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
