import { AsyncLocalStorage } from "node:async_hooks";
import { emitRuntimeLog } from "@rakazo/core";

/** Run identity for transport failures raised deep inside a provider SDK fetch. */
export interface ModelTransportLogContext {
  runId?: string;
  threadId?: string | null;
  lane?: string | null;
  provider?: string;
  model?: string;
}

const transportLogContext = new AsyncLocalStorage<ModelTransportLogContext>();

/** Runs `fn` so provider fetches started inside it can attribute transport failures. */
export function withModelTransportLogContext<T>(
  context: ModelTransportLogContext | undefined,
  fn: () => T,
): T {
  return context ? transportLogContext.run(context, fn) : fn();
}

const MAX_CAUSE_DEPTH = 5;
const MAX_MESSAGE_CHARS = 160;

/** Strips URL paths/queries, credentials and long opaque tokens from an error message. */
export function sanitizeTransportErrorMessage(message: string): string {
  return message
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@'"]*@)?([^\s/?#'"]+)[^\s'"]*/gi, "$1$2")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|xai|gsk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[=:]\s*[^\s"',;&]+/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

/** `name[code]: message` for each level of the cause chain, outermost first. */
export function describeErrorCauseChain(error: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error || typeof current === "object") {
      const value = current as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      const name = typeof value.name === "string" ? value.name.slice(0, 40) : "Error";
      const code =
        typeof value.code === "string" || typeof value.code === "number"
          ? `[${String(value.code).slice(0, 40)}]`
          : "";
      const message =
        typeof value.message === "string" ? sanitizeTransportErrorMessage(value.message) : "";
      chain.push(`${name}${code}: ${message}`);
      current = value.cause;
    } else {
      chain.push(sanitizeTransportErrorMessage(String(current)));
      break;
    }
  }
  return chain;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: unknown }).name === "AbortError" ||
      (error as { name?: unknown }).name === "TimeoutError")
  );
}

/** Mirrors a sanitized transport failure (no URL path/query, headers or keys) to runtime logs. */
export function reportModelTransportError(error: unknown, url: URL): void {
  if (isAbortError(error)) return;
  try {
    const context = transportLogContext.getStore();
    const causes = describeErrorCauseChain(error).join(" <- ");
    const parts = [
      context?.provider ? `provider=${context.provider}` : "",
      context?.model ? `model=${context.model}` : "",
      `host=${url.hostname}`,
      `causes=${causes}`,
    ].filter(Boolean);
    const summary = parts.join(" ").slice(0, 600);
    try {
      process.stdout.write(
        `${JSON.stringify({
          rakazo_timing: "model.transport_error",
          ts: new Date().toISOString(),
          runId: context?.runId,
          threadId: context?.threadId ?? undefined,
          summary,
        })}\n`,
      );
    } catch {
      // Logging must never affect a run.
    }
    emitRuntimeLog({
      code: "model.transport_error",
      level: "error",
      runId: context?.runId ?? null,
      threadId: context?.threadId ?? null,
      lane: context?.lane ?? null,
      ok: false,
      summary,
    });
  } catch {
    // Logging must never mask the transport error.
  }
}
