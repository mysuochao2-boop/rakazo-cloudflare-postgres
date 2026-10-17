/**
 * Per-bot live runtime logs (RAKAZO_BOT_LIVE_LOGS). Runtime code reports operational
 * milestones (timing steps, tool outcomes, turn limits) through one process-wide tap.
 * The tap is installed only by composition roots when the flag is on, so an unset
 * environment never writes anything and `emitRuntimeLog` stays a no-op.
 *
 * Entries carry metadata only: no prompt text, tool arguments, tool output, or images.
 */
import type { EnvLike } from "./agent-flags.js";

export type RuntimeLogLevel = "info" | "warn" | "error";

export interface RuntimeLogEntry {
  /** Stable machine code, e.g. `tool.end`, `model.first_token`, `agent.turn_limit`. */
  code: string;
  level?: RuntimeLogLevel;
  runId?: string | null;
  threadId?: string | null;
  lane?: string | null;
  ms?: number | null;
  tool?: string | null;
  ok?: boolean | null;
  /** Short, already-structured detail (counts, limits). Redacted again before storage. */
  summary?: string | null;
}

export type RuntimeLogTap = (entry: RuntimeLogEntry) => void;

const processEnv = (): EnvLike =>
  (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};

/** RAKAZO_BOT_LIVE_LOGS=1 mirrors redacted runtime milestones into the per-bot log view. */
export function botLiveLogsEnabled(env: EnvLike = processEnv()): boolean {
  const normalized = env.RAKAZO_BOT_LIVE_LOGS?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

let tap: RuntimeLogTap | undefined;

export function setRuntimeLogTap(next: RuntimeLogTap | undefined): void {
  tap = next;
}

export function emitRuntimeLog(entry: RuntimeLogEntry): void {
  if (!tap) return;
  try {
    tap(entry);
  } catch {
    // Live logs must never affect a run.
  }
}

/** Timing fields that are safe to keep; everything else is dropped. */
const TIMING_SUMMARY_KEYS = [
  "kind",
  "cold",
  "available",
  "attempts",
  "provider",
  "model",
  "status",
] as const;

/** Maps a `rakazo_timing` step to a live log entry (metadata only). */
export function runtimeLogFromTiming(
  step: string,
  fields: { [key: string]: unknown },
): RuntimeLogEntry {
  const parts: string[] = [];
  for (const key of TIMING_SUMMARY_KEYS) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
  }
  const ok = typeof fields.ok === "boolean" ? fields.ok : null;
  return {
    code: step,
    level: ok === false ? "warn" : "info",
    runId: typeof fields.runId === "string" ? fields.runId : null,
    threadId: typeof fields.threadId === "string" ? fields.threadId : null,
    lane: typeof fields.lane === "string" ? fields.lane : null,
    ms: typeof fields.ms === "number" ? fields.ms : null,
    tool: typeof fields.tool === "string" ? fields.tool : null,
    ok,
    summary: parts.length ? parts.join(" ") : null,
  };
}

const AGENT_STRING_KEYS = new Set(["kind", "mode", "reason", "format"]);

/**
 * Summarizes `agent.*` structured log fields: numbers and booleans, plus a few enum-like
 * string keys. Free text (errors, names, content) is never copied.
 */
export function summarizeAgentLogFields(fields: { [key: string]: unknown }): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "runId" || key === "lane" || key === "threadId") continue;
    if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${value}`);
    else if (
      typeof value === "string" &&
      AGENT_STRING_KEYS.has(key) &&
      /^[\w.:-]{1,40}$/.test(value)
    ) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length ? parts.join(" ").slice(0, 300) : null;
}
