export const TRANSCRIPTION_FAILURE_CODES = [
  "audio_unavailable",
  "audio_too_large",
  "audio_too_long",
  "conversion_failed",
  "request_failed",
  "empty_transcript",
  "response_too_large",
  "timeout",
  "service_stopping",
] as const;

export type VoiceTranscription = {
  provider: "openrouter";
  model: string;
} & (
  | { status: "completed"; text: string }
  | {
      status: "unavailable";
      code: (typeof TRANSCRIPTION_FAILURE_CODES)[number];
    }
);

export const MAX_TRANSCRIPT_BYTES = 50 * 1024;

export function isVoiceTranscription(
  value: unknown,
): value is VoiceTranscription {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("provider" in value) ||
    value.provider !== "openrouter" ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    !value.model.trim()
  )
    return false;
  if (!("status" in value)) return false;
  if (value.status === "completed") {
    return (
      Object.keys(value).every((key) =>
        ["provider", "model", "status", "text"].includes(key),
      ) &&
      "text" in value &&
      typeof value.text === "string" &&
      value.text.trim().length > 0 &&
      Buffer.byteLength(value.text) <= MAX_TRANSCRIPT_BYTES
    );
  }
  return (
    value.status === "unavailable" &&
    Object.keys(value).every((key) =>
      ["provider", "model", "status", "code"].includes(key),
    ) &&
    "code" in value &&
    TRANSCRIPTION_FAILURE_CODES.some((code) => code === value.code)
  );
}
