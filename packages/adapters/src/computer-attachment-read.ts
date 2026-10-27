import { type AttachmentMimeType, COMPUTER_ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  formatAttachmentByteLimit,
  inferAttachmentMimeType,
  redactSecrets,
  unsupportedAttachmentTypeMessage,
} from "@rakazo/core";

export type ComputerFileReadFailure = "not_found" | "too_large" | "path_invalid" | "read_failed";

const DETAIL_MAX_LENGTH = 160;

/** Drops secrets, absolute paths, and bulky payloads from a provider error before the model sees it. */
export function sanitizeComputerReadDetail(
  message: string,
  secrets: readonly string[] = [],
): string {
  const redacted = redactSecrets(message, [...secrets])
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    // Absolute paths can carry user names or private folder names.
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`,;:)\]}]+){2,}/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, DETAIL_MAX_LENGTH)}…`
    : redacted;
}

/**
 * Maps a sandbox/home read error to one specific, actionable reason. Providers phrase
 * these differently (supervisor HTTP status + body, Node errno, gateway text), so this
 * matches the shared markers rather than one provider's exact wording.
 */
export function classifyComputerReadError(
  error: unknown,
  options: { maxBytes: number; secrets?: readonly string[] },
): { reason: ComputerFileReadFailure; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const text = `${code} ${raw}`;
  if (/exceeds|too large|\b413\b|EFBIG/i.test(text)) {
    return {
      reason: "too_large",
      message: `file is too large to attach (limit ${formatAttachmentByteLimit(options.maxBytes)})`,
    };
  }
  if (/escapes|invalid (?:file|path)|EISDIR|ENOTDIR|ELOOP|is a directory|\b400\b/i.test(text)) {
    return {
      reason: "path_invalid",
      message:
        'invalid path: use a file path relative to this bot\'s workspace (no "..", not a directory or symlink)',
    };
  }
  if (/EACCES|EPERM|permission denied|PermissionError/i.test(text)) {
    return {
      reason: "read_failed",
      message: `could not read file: permission denied (${sanitizeComputerReadDetail(raw, options.secrets)})`,
    };
  }
  if (/ENOENT|not found|no such file|FileNotFoundError|\b404\b/i.test(text)) {
    return {
      reason: "not_found",
      message: "file not found: check the path with list_files (relative to this bot's workspace)",
    };
  }
  return {
    reason: "read_failed",
    message: `could not read file: ${sanitizeComputerReadDetail(raw, options.secrets) || "unknown error"}`,
  };
}

export type ComputerAttachmentRead =
  | { ok: true; bytes: Uint8Array; mimeType: AttachmentMimeType }
  | {
      ok: false;
      reason: ComputerFileReadFailure | "missing_path" | "unsupported_type";
      error: string;
    };

/**
 * Validates and reads one workspace file for attach_file. The type check runs
 * first so an unsupported file never costs a Computer round trip, and the read
 * never asks for more than the Computer will serve.
 */
export async function readComputerAttachment(input: {
  filePath: string;
  resolvePath: (filePath: string) => string;
  readFile: (storedPath: string, options: { maxBytes: number }) => Promise<Uint8Array>;
  secrets?: readonly string[];
  maxBytes?: number;
}): Promise<ComputerAttachmentRead> {
  const maxBytes = input.maxBytes ?? COMPUTER_ATTACHMENT_MAX_BYTES;
  if (!input.filePath.trim()) {
    return { ok: false, reason: "missing_path", error: "path is required" };
  }
  const mimeType = inferAttachmentMimeType(input.filePath);
  if (!mimeType) {
    return {
      ok: false,
      reason: "unsupported_type",
      error: unsupportedAttachmentTypeMessage(input.filePath),
    };
  }
  let storedPath: string;
  try {
    storedPath = input.resolvePath(input.filePath);
  } catch (error) {
    const failure = classifyComputerReadError(error, { maxBytes, secrets: input.secrets });
    return { ok: false, reason: failure.reason, error: failure.message };
  }
  try {
    const bytes = await input.readFile(storedPath, { maxBytes });
    // Providers without a native cap (or a misbehaving one) still cannot exceed it.
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        reason: "too_large",
        error: `file is too large to attach (limit ${formatAttachmentByteLimit(maxBytes)})`,
      };
    }
    return { ok: true, bytes, mimeType };
  } catch (error) {
    const failure = classifyComputerReadError(error, { maxBytes, secrets: input.secrets });
    return { ok: false, reason: failure.reason, error: failure.message };
  }
}
