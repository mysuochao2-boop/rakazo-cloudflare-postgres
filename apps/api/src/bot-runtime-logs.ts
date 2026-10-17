import { ORPCError } from "@orpc/server";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type {
  Actor,
  BotRuntimeLogEntry,
  BotRuntimeLogStreamItem,
  BotRuntimeLogsPage,
} from "@rakazo/contracts";
import { botLiveLogsEnabled } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  botRuntimeOverview,
  followBotRuntimeLogs,
  IsolationError,
  listBotRuntimeLogs,
} from "@rakazo/db";

/** Live logs follow bot ownership: the same check as editing the bot. */
export async function assertCanManageBot(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
): Promise<void> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
}

function assertEnabled(): void {
  if (!botLiveLogsEnabled()) throw new ORPCError("NOT_FOUND", { message: "Live logs are off." });
}

export async function botRuntimeLogsPage(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { botId: string; before?: number; runId?: string; limit: number },
): Promise<BotRuntimeLogsPage> {
  if (!botLiveLogsEnabled()) {
    return { enabled: false, entries: [], cursor: -1, runs: [], backgroundTasks: [] };
  }
  await assertCanManageBot(prisma, actor, input.botId);
  const [entries, overview] = await Promise.all([
    listBotRuntimeLogs(prisma, input),
    botRuntimeOverview(prisma, { spaceId: actor.spaceId, botId: input.botId }),
  ]);
  return {
    enabled: true,
    entries,
    cursor: entries.at(-1)?.seq ?? -1,
    ...overview,
  };
}

/**
 * SSE body for `bots.logs.subscribe`. Mirrors `threads.subscribe`: heartbeats punctuate
 * silence so clients can detect a half-open stream, and the session is re-checked while
 * the stream stays open.
 */
export async function* streamBotRuntimeLogs(options: {
  prisma: PrismaClient;
  realtime?: RealtimeFanout;
  actor: Pick<Actor, "spaceId" | "userId">;
  input: { botId: string; cursor: number };
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
  heartbeatMs: number;
  recheckMs: number;
}): AsyncGenerator<BotRuntimeLogStreamItem> {
  assertEnabled();
  const { prisma, actor, input, signal } = options;
  await assertCanManageBot(prisma, actor, input.botId);
  const follow = followBotRuntimeLogs(prisma, input.botId, input.cursor, options.realtime, signal);
  let pending: Promise<IteratorResult<BotRuntimeLogEntry>> | undefined;
  let checkedAt = Date.now();
  const recheck = async () => {
    if (Date.now() - checkedAt < options.recheckMs) return;
    if (options.stillAuthorized && !(await options.stillAuthorized())) {
      throw new ORPCError("UNAUTHORIZED");
    }
    // Ownership can change while the stream is open (bot archived, moved, or deleted).
    await assertCanManageBot(prisma, actor, input.botId);
    checkedAt = Date.now();
  };
  try {
    while (!signal?.aborted) {
      pending ??= follow.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        pending,
        new Promise<"silent">((resolve) => {
          timer = setTimeout(() => resolve("silent"), options.heartbeatMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next === "silent") {
        await recheck();
        yield { type: "heartbeat", ts: new Date().toISOString() };
        continue;
      }
      pending = undefined;
      if (next.done) return;
      await recheck();
      yield { type: "bot.log.append", entry: next.value };
    }
  } finally {
    void follow.return(undefined).catch(() => {});
  }
}
