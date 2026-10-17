import type { BotRuntimeLogEntry, BotRuntimeRunSummary } from "@rakazo/contracts";

/** Keeps the drawer bounded; older lines are still pageable from the server. */
export const LIVE_LOG_BUFFER = 1_000;

export type LaneFilter = "all" | "interactive" | "background";

export interface LogFilter {
  lane: LaneFilter;
  errorsOnly: boolean;
  runId: string | null;
}

/** Merges by seq (deduped, ascending) and keeps the newest `cap` lines. */
export function mergeLogEntries(
  current: readonly BotRuntimeLogEntry[],
  incoming: readonly BotRuntimeLogEntry[],
  cap = LIVE_LOG_BUFFER,
): BotRuntimeLogEntry[] {
  if (!incoming.length) return current as BotRuntimeLogEntry[];
  const bySeq = new Map<number, BotRuntimeLogEntry>();
  for (const entry of current) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function isProblemEntry(entry: BotRuntimeLogEntry): boolean {
  return entry.level !== "info" || entry.ok === false;
}

export function filterLogEntries(
  entries: readonly BotRuntimeLogEntry[],
  filter: LogFilter,
  runLanes: ReadonlyMap<string, string> = new Map(),
): BotRuntimeLogEntry[] {
  return entries.filter((entry) => {
    if (filter.runId && entry.runId !== filter.runId) return false;
    if (filter.errorsOnly && !isProblemEntry(entry)) return false;
    if (filter.lane !== "all") {
      const lane = entry.lane ?? (entry.runId ? runLanes.get(entry.runId) : undefined);
      if (lane !== filter.lane) return false;
    }
    return true;
  });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

/** One-line rendering of a log entry: code, tool, outcome, duration, summary. */
export function formatLogLine(entry: BotRuntimeLogEntry): string {
  const parts = [entry.code];
  if (entry.tool) parts.push(entry.tool);
  if (entry.ok === false) parts.push("failed");
  if (entry.ms != null) parts.push(formatDuration(entry.ms));
  if (entry.summary) parts.push(entry.summary);
  return parts.join(" · ");
}

/** Milestones of one run, in the order a send travels through the system. */
export const RUN_MILESTONES = [
  { code: "send.enqueued", label: "queued" },
  { code: "runtime.accepted", label: "accepted" },
  { code: "run.leased", label: "leased" },
  { code: "computer.ready", label: "computer" },
  { code: "model.first_token", label: "first token" },
  { code: "model.stream_end", label: "done" },
] as const;

export interface RunCard {
  runId: string;
  lane: string;
  status: string | null;
  trigger: string | null;
  error: string | null;
  startedAt: string;
  /** Milestone label → ms since the run's first log line. */
  milestones: Array<{ label: string; offsetMs: number }>;
  toolCalls: number;
  toolFailures: number;
  problems: number;
  lastAt: string;
}

/** Builds run cards newest first, joining log lines with the server's run rows. */
export function buildRunCards(
  entries: readonly BotRuntimeLogEntry[],
  runs: readonly BotRuntimeRunSummary[],
  limit = 8,
): RunCard[] {
  const byRun = new Map<string, BotRuntimeLogEntry[]>();
  for (const entry of entries) {
    if (!entry.runId) continue;
    const list = byRun.get(entry.runId) ?? [];
    list.push(entry);
    byRun.set(entry.runId, list);
  }
  const summaries = new Map(runs.map((run) => [run.id, run]));
  const ids = new Set<string>([...runs.map((run) => run.id), ...byRun.keys()]);
  const cards: RunCard[] = [];
  for (const runId of ids) {
    const lines = byRun.get(runId) ?? [];
    const run = summaries.get(runId);
    const first = lines[0];
    const startedAt = run?.createdAt ?? first?.ts;
    if (!startedAt) continue;
    const origin = Date.parse(first?.ts ?? startedAt);
    const milestones: RunCard["milestones"] = [];
    for (const milestone of RUN_MILESTONES) {
      const hit = lines.find((line) => line.code === milestone.code);
      if (hit) milestones.push({ label: milestone.label, offsetMs: Date.parse(hit.ts) - origin });
    }
    const tools = lines.filter((line) => line.code === "tool.end");
    cards.push({
      runId,
      lane: run?.lane ?? lines.find((line) => line.lane)?.lane ?? "interactive",
      status: run?.status ?? null,
      trigger: run?.trigger ?? null,
      error: run?.error ?? null,
      startedAt,
      milestones,
      toolCalls: tools.length,
      toolFailures: tools.filter((line) => line.ok === false).length,
      problems: lines.filter(isProblemEntry).length,
      lastAt: lines.at(-1)?.ts ?? run?.completedAt ?? startedAt,
    });
  }
  return cards.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
}

/** Log codes after which the run/task overview is worth refetching. */
export function shouldRefreshOverview(entry: BotRuntimeLogEntry): boolean {
  return (
    entry.code === "send.enqueued" ||
    entry.code === "runtime.accepted" ||
    entry.code === "model.stream_end" ||
    entry.code === "run.final_persist" ||
    entry.code === "run.error" ||
    entry.code.startsWith("agent.turn_limit")
  );
}
