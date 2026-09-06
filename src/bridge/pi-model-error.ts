// Summarize Pi model errors into allowlisted log fields.
// Never log the raw provider message: it may echo request content.
export interface PiModelErrorSummary {
  error_kind: string;
  http_status?: number;
  provider_code?: string;
  error_param?: string;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.\-]+$/;
const SAFE_PARAM = /^[A-Za-z0-9_.\-[\]]+$/;

function safeToken(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) return undefined;
  return SAFE_TOKEN.test(text) ? text : undefined;
}

function safeParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > 128) return undefined;
  return SAFE_PARAM.test(text) ? text : undefined;
}

export function summarizePiModelError(
  errorMessage: string | undefined,
): PiModelErrorSummary {
  if (!errorMessage || errorMessage.trim().length === 0) {
    return { error_kind: "empty_model_error" };
  }
  const statusMatch = errorMessage.match(/\((\d{3})\)/);
  const http_status =
    statusMatch?.[1] !== undefined &&
    Number(statusMatch[1]) >= 100 &&
    Number(statusMatch[1]) <= 599
      ? Number(statusMatch[1])
      : undefined;
  const bodyStart = errorMessage.indexOf("{");
  if (bodyStart >= 0) {
    try {
      const body: unknown = JSON.parse(errorMessage.slice(bodyStart));
      if (typeof body === "object" && body !== null) {
        const record = body as Record<string, unknown>;
        const error_kind = safeToken(record["type"], 64) ?? "model_error";
        const provider_code = safeToken(record["code"], 64);
        const error_param = safeParam(record["param"]);
        return {
          error_kind,
          ...(http_status !== undefined ? { http_status } : {}),
          ...(provider_code ? { provider_code } : {}),
          ...(error_param ? { error_param } : {}),
        };
      }
    } catch {
      // Fall through to the generic summary below.
    }
  }
  return {
    error_kind: "model_error",
    ...(http_status !== undefined ? { http_status } : {}),
  };
}
