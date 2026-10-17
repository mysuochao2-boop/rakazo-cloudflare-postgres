import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type {
  BotRuntimeBackgroundTask,
  BotRuntimeLogEntry,
  BotRuntimeRunSummary,
} from "@rakazo/contracts";
import type { RuntimeLogEntry, RuntimeLogLevel, RuntimeLogTap } from "@rakazo/core";
import { getLogger, redactSensitiveText } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { ChangeLatch } from "./events.js";

/**
 * Durable store behind per-bot live runtime logs (RAKAZO_BOT_LIVE_LOGS).
 * Writers batch redacted metadata rows and publish a cursor on `bot-logs:<botId>`;
 * readers page with `listBotRuntimeLogs` and stream with `followBotRuntimeLogs`.
 */

export const BOT_RUNTIME_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const FOLLOW_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 1_000;
const SUMMARY_MAX = 240;
const CONTEXT_CACHE_MAX = 500;

type StoredLevel = RuntimeLogLevel;

export interface SanitizedRuntimeLog {
  code: string;
  level: StoredLevel;
  runId: string | null;
  threadId: string | null;
  lane: "interactive" | "background" | null;
  ms: number | null;
  tool: string | null;
  ok: boolean | null;
  summary: string | null;
}

const CODE = /^[a-z][a-z0-9_.]{0,63}$/i;
const TOOL = /^[\w.:/-]{1,80}$/;
const ID = /^[\w-]{1,64}$/;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const DATA_URI = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/gi;
const LONG_OPAQUE = /[A-Za-z0-9+/_=-]{48,}/g;

/** Redacts free text for a log summary: secrets, URL credentials, base64, long tokens. */
export function redactRuntimeLogText(value: string): string {
  // URL credentials first, before the email pattern can swallow `user:pass@host`.
  return redactSensitiveText(
    value.replace(DATA_URI, "[image]").replace(URL_CREDENTIALS, "$1[redacted]@"),
  )
    .replace(LONG_OPAQUE, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_MAX);
}

/** Returns null when the entry is not safe or not useful to store. */
export function sanitizeRuntimeLogEntry(entry: RuntimeLogEntry): SanitizedRuntimeLog | null {
  if (typeof entry.code !== "string" || !CODE.test(entry.code)) return null;
  const level: StoredLevel =
    entry.level === "warn" || entry.level === "error" ? entry.level : "info";
  const ms =
    typeof entry.ms === "number" && Number.isFinite(entry.ms)
      ? Math.min(Math.max(Math.round(entry.ms), 0), 2_147_483_647)
      : null;
  const summary = typeof entry.summary === "string" ? redactRuntimeLogText(entry.summary) : "";
  return {
    code: entry.code,
    level,
    runId: typeof entry.runId === "string" && ID.test(entry.runId) ? entry.runId : null,
    threadId: typeof entry.threadId === "string" && ID.test(entry.threadId) ? entry.threadId : null,
    lane: entry.lane === "interactive" || entry.lane === "background" ? entry.lane : null,
    ms,
    tool: typeof entry.tool === "string" ? (TOOL.test(entry.tool) ? entry.tool : "[tool]") : null,
    ok: typeof entry.ok === "boolean" ? entry.ok : null,
    summary: summary || null,
  };
}

export function botRuntimeLogTopic(botId: string): string {
  return `bot-logs:${botId}`;
}

interface LogContext {
  spaceId: string;
  botId: string;
  threadId: string | null;
  lane: string | null;
}

export interface BotRuntimeLogWriter {
  tap: RuntimeLogTap;
  /** Writes everything queued so far. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface BotRuntimeLogWriterOptions {
  flushMs?: number;
  maxBatch?: number;
  /** Entries beyond this are dropped rather than buffered without bound. */
  maxQueue?: number;
  retentionMs?: number;
  pruneEveryMs?: number;
  now?: () => number;
}

/**
 * Builds the process tap. Entries are queued synchronously and written in batches off the
 * hot path; every failure is swallowed so live logs can never slow or fail a run.
 */
export function createBotRuntimeLogWriter(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  options: BotRuntimeLogWriterOptions = {},
): BotRuntimeLogWriter {
  const flushMs = options.flushMs ?? 400;
  const maxBatch = options.maxBatch ?? 100;
  const maxQueue = options.maxQueue ?? 1_000;
  const retentionMs = options.retentionMs ?? BOT_RUNTIME_LOG_RETENTION_MS;
  const pruneEveryMs = options.pruneEveryMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const queue: Array<{ entry: SanitizedRuntimeLog; at: Date }> = [];
  const contexts = new Map<string, Promise<LogContext | null>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let lastPruneAt = 0;
  let dropped = 0;
  let closed = false;

  const cached = (key: string, load: () => Promise<LogContext | null>) => {
    const hit = contexts.get(key);
    if (hit) return hit;
    const pending = load().catch(() => null);
    contexts.set(key, pending);
    // A miss (e.g. the row commits a moment later) should be retried on the next entry.
    void pending.then((value) => {
      if (!value) contexts.delete(key);
    });
    if (contexts.size > CONTEXT_CACHE_MAX) {
      const oldest = contexts.keys().next().value;
      if (oldest !== undefined) contexts.delete(oldest);
    }
    return pending;
  };

  const resolveContext = (entry: SanitizedRuntimeLog): Promise<LogContext | null> => {
    if (entry.runId) {
      return cached(`run:${entry.runId}`, async () => {
        const run = await prisma.run.findUnique({
          where: { id: entry.runId! },
          select: { spaceId: true, botId: true, threadId: true, lane: true },
        });
        return run
          ? { spaceId: run.spaceId, botId: run.botId, threadId: run.threadId, lane: run.lane }
          : null;
      });
    }
    if (entry.threadId) {
      return cached(`thread:${entry.threadId}`, async () => {
        const thread = await prisma.thread.findUnique({
          where: { id: entry.threadId! },
          select: { spaceId: true, botId: true },
        });
        // Group threads have no single bot; their lines arrive again with a runId.
        return thread?.botId
          ? { spaceId: thread.spaceId, botId: thread.botId, threadId: entry.threadId, lane: null }
          : null;
      });
    }
    return Promise.resolve(null);
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const writeBatch = async (batch: Array<{ entry: SanitizedRuntimeLog; at: Date }>) => {
    const resolved = await Promise.all(batch.map((item) => resolveContext(item.entry)));
    const rows = batch.flatMap((item, index) => {
      const context = resolved[index];
      if (!context) return [];
      return [
        {
          spaceId: context.spaceId,
          botId: context.botId,
          runId: item.entry.runId,
          threadId: item.entry.threadId ?? context.threadId,
          lane: item.entry.lane ?? context.lane,
          level: item.entry.level,
          code: item.entry.code,
          tool: item.entry.tool,
          ok: item.entry.ok,
          ms: item.entry.ms,
          summary: item.entry.summary,
          createdAt: item.at,
        },
      ];
    });
    if (!rows.length) return;
    const created = await prisma.botRuntimeLog.createManyAndReturn({
      data: rows,
      select: { seq: true, botId: true },
    });
    const cursors = new Map<string, bigint>();
    for (const row of created) {
      const current = cursors.get(row.botId);
      if (current === undefined || row.seq > current) cursors.set(row.botId, row.seq);
    }
    await Promise.all(
      [...cursors].map(([botId, seq]) =>
        realtime
          ?.publish(botRuntimeLogTopic(botId), JSON.stringify({ cursor: Number(seq) }))
          .catch(() => undefined),
      ),
    );
  };

  const prune = async () => {
    const at = now();
    if (at - lastPruneAt < pruneEveryMs) return;
    lastPruneAt = at;
    await prisma.botRuntimeLog.deleteMany({
      where: { createdAt: { lt: new Date(at - retentionMs) } },
    });
  };

  const flush = (): Promise<void> => {
    if (flushing) return flushing.then(() => (queue.length ? flush() : undefined));
    flushing = (async () => {
      while (queue.length) {
        const batch = queue.splice(0, maxBatch);
        try {
          await writeBatch(batch);
        } catch (error) {
          getLogger().warn("bot runtime logs write failed", {
            count: batch.length,
            error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          });
        }
      }
      try {
        await prune();
      } catch {
        // Retention is best effort; the next flush retries.
      }
      if (dropped) {
        getLogger().warn("bot runtime logs dropped", { count: dropped });
        dropped = 0;
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  return {
    tap(entry) {
      if (closed) return;
      const sanitized = sanitizeRuntimeLogEntry(entry);
      if (!sanitized) return;
      if (queue.length >= maxQueue) {
        dropped += 1;
        return;
      }
      queue.push({ entry: sanitized, at: new Date(now()) });
      if (queue.length >= maxBatch) void flush();
      else schedule();
    },
    flush,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await flush();
    },
  };
}

type BotRuntimeLogRow = {
  seq: bigint;
  runId: string | null;
  threadId: string | null;
  lane: string | null;
  level: string;
  code: string;
  tool: string | null;
  ok: boolean | null;
  ms: number | null;
  summary: string | null;
  createdAt: Date;
};

export function mapBotRuntimeLog(row: BotRuntimeLogRow): BotRuntimeLogEntry {
  return {
    seq: Number(row.seq),
    ts: row.createdAt.toISOString(),
    runId: row.runId,
    threadId: row.threadId,
    lane: row.lane === "interactive" || row.lane === "background" ? row.lane : null,
    level: row.level === "warn" || row.level === "error" ? row.level : "info",
    code: row.code,
    tool: row.tool,
    ok: row.ok,
    ms: row.ms,
    summary: row.summary,
  };
}

export async function listBotRuntimeLogs(
  prisma: PrismaClient,
  input: { botId: string; before?: number; runId?: string; limit: number; now?: number },
): Promise<BotRuntimeLogEntry[]> {
  const since = new Date((input.now ?? Date.now()) - BOT_RUNTIME_LOG_RETENTION_MS);
  const rows = await prisma.botRuntimeLog.findMany({
    where: {
      botId: input.botId,
      createdAt: { gte: since },
      ...(input.before ? { seq: { lt: BigInt(input.before) } } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    },
    orderBy: { seq: "desc" },
    take: input.limit,
  });
  return rows.reverse().map(mapBotRuntimeLog);
}

const RUN_ERROR_MAX = 300;

/** Recent runs and background tasks for the run cards beside the log stream. */
export async function botRuntimeOverview(
  prisma: PrismaClient,
  input: { spaceId: string; botId: string; limit?: number },
): Promise<{ runs: BotRuntimeRunSummary[]; backgroundTasks: BotRuntimeBackgroundTask[] }> {
  const [runs, tasks] = await Promise.all([
    prisma.run.findMany({
      where: { spaceId: input.spaceId, botId: input.botId },
      orderBy: { createdAt: "desc" },
      take: input.limit ?? 20,
      select: {
        id: true,
        lane: true,
        trigger: true,
        status: true,
        error: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.backgroundTask.findMany({
      where: { spaceId: input.spaceId, botId: input.botId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        runId: true,
        title: true,
        status: true,
        progress: true,
        stepsUsed: true,
        stepCap: true,
        updatedAt: true,
      },
    }),
  ]);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      lane: run.lane,
      trigger: run.trigger,
      status: run.status,
      error: run.error ? redactRuntimeLogText(run.error).slice(0, RUN_ERROR_MAX) : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
    })),
    backgroundTasks: tasks.map((task) => ({
      id: task.id,
      runId: task.runId,
      title: redactRuntimeLogText(task.title).slice(0, 120),
      status: task.status,
      progress: task.progress ? redactRuntimeLogText(task.progress) : null,
      stepsUsed: task.stepsUsed,
      stepCap: task.stepCap,
      updatedAt: task.updatedAt.toISOString(),
    })),
  };
}

export async function* followBotRuntimeLogs(
  prisma: PrismaClient,
  botId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<BotRuntimeLogEntry> {
  let seq = BigInt(Math.max(cursor, 0));
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(botRuntimeLogTopic(botId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const rows = await prisma.botRuntimeLog.findMany({
          where: { botId, seq: { gt: seq } },
          orderBy: { seq: "asc" },
          take: FOLLOW_BATCH_SIZE,
        });
        batchSize = rows.length;
        for (const row of rows) {
          seq = row.seq;
          yield mapBotRuntimeLog(row);
        }
      } while (batchSize === FOLLOW_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}
