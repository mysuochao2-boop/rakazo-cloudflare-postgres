import { redactSecrets } from "@rakazo/core";

/**
 * Sanitized, provider-shaped transcript of one run (RunTranscript.messages).
 * Only assistant (text / thinking / toolCall) and toolResult messages are stored.
 * Images never enter the store; secrets are redacted; tool results are clipped.
 */
export const RUN_TRANSCRIPT_FORMAT_VERSION = 1;
export const TRANSCRIPT_TOOL_RESULT_LIMIT = 12_000;
export const TRANSCRIPT_MAX_BYTES = 256 * 1024;

export type TranscriptTextPart = { type: "text"; text: string };
export type TranscriptThinkingPart = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};
export type TranscriptToolCallPart = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
};
export interface TranscriptAssistantMessage {
  role: "assistant";
  content: Array<TranscriptTextPart | TranscriptThinkingPart | TranscriptToolCallPart>;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  timestamp?: number;
}
export interface TranscriptToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TranscriptTextPart[];
  isError?: boolean;
  timestamp?: number;
}
export type TranscriptMessage = TranscriptAssistantMessage | TranscriptToolResultMessage;

export interface SanitizedTranscript {
  messages: TranscriptMessage[];
  bytes: number;
  /** True when size control had to shorten or drop content beyond the per-result clip. */
  truncated: boolean;
}

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]"],
  [/sk-[a-zA-Z0-9-]{12,}/g, "[redacted]"],
  [/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]"],
  [/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]"],
  [/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi, "$1[redacted]"],
];

export function redactTranscriptText(text: string, secrets: readonly string[]): string {
  let result = redactSecrets(text, [...secrets]);
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = Math.max(0, limit - head - 40);
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactTranscriptText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]),
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function imagePlaceholder(part: Record<string, unknown>): TranscriptTextPart {
  const mime = typeof part.mimeType === "string" ? part.mimeType : "image";
  return { type: "text", text: `[screenshot omitted: ${mime}]` };
}

function sanitizeAssistant(
  message: Record<string, unknown>,
  secrets: readonly string[],
): TranscriptAssistantMessage | undefined {
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: TranscriptAssistantMessage["content"] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: redactTranscriptText(part.text, secrets) });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        thinking: redactTranscriptText(String(part.thinking ?? ""), secrets),
        ...(typeof part.thinkingSignature === "string"
          ? { thinkingSignature: part.thinkingSignature }
          : {}),
        ...(part.redacted === true ? { redacted: true } : {}),
      });
    } else if (part.type === "toolCall" && typeof part.id === "string") {
      const args = asRecord(redactValue(part.arguments ?? {}, secrets)) ?? {};
      parts.push({
        type: "toolCall",
        id: part.id,
        name: String(part.name ?? "tool"),
        arguments: args,
        ...(typeof part.thoughtSignature === "string"
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      });
    }
  }
  if (parts.length === 0) return undefined;
  return {
    role: "assistant",
    content: parts,
    ...(typeof message.api === "string" ? { api: message.api } : {}),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
  };
}

function sanitizeToolResult(
  message: Record<string, unknown>,
  secrets: readonly string[],
  limit: number,
): TranscriptToolResultMessage | undefined {
  if (typeof message.toolCallId !== "string") return undefined;
  const raw = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  const texts: string[] = [];
  for (const item of raw) {
    const part = asRecord(item);
    if (!part) continue;
    if (part.type === "image") texts.push(imagePlaceholder(part).text);
    else if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  const text = clip(redactTranscriptText(texts.join("\n"), secrets), limit);
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: String(message.toolName ?? "tool"),
    content: [{ type: "text", text }],
    ...(message.isError === true ? { isError: true } : {}),
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
  };
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function sanitizeTranscript(
  messages: readonly unknown[],
  secrets: readonly string[] = [],
  options: { maxBytes?: number; toolResultLimit?: number } = {},
): SanitizedTranscript {
  const maxBytes = options.maxBytes ?? TRANSCRIPT_MAX_BYTES;
  const build = (limit: number) =>
    messages.flatMap((raw): TranscriptMessage[] => {
      const message = asRecord(raw);
      if (!message) return [];
      if (message.role === "assistant") {
        const sanitized = sanitizeAssistant(message, secrets);
        return sanitized ? [sanitized] : [];
      }
      if (message.role === "toolResult") {
        const sanitized = sanitizeToolResult(message, secrets, limit);
        return sanitized ? [sanitized] : [];
      }
      return [];
    });
  for (const limit of [options.toolResultLimit ?? TRANSCRIPT_TOOL_RESULT_LIMIT, 2_000, 300]) {
    const result = build(limit);
    const bytes = byteLength(result);
    if (bytes <= maxBytes) {
      return {
        messages: result,
        bytes,
        truncated: limit !== (options.toolResultLimit ?? TRANSCRIPT_TOOL_RESULT_LIMIT),
      };
    }
  }
  // Still too large (huge tool-call arguments or text): keep only final assistant text.
  const finalText = build(300)
    .filter((message): message is TranscriptAssistantMessage => message.role === "assistant")
    .flatMap((message) => message.content.filter((part) => part.type === "text"))
    .map((part) => (part as TranscriptTextPart).text)
    .join("\n");
  const fallback: TranscriptMessage[] = finalText
    ? [
        {
          role: "assistant",
          content: [{ type: "text", text: clip(finalText, Math.floor(maxBytes / 4)) }],
        },
      ]
    : [];
  return { messages: fallback, bytes: byteLength(fallback), truncated: true };
}
