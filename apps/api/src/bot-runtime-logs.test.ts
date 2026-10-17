import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botRuntimeLogsPage, streamBotRuntimeLogs } from "./bot-runtime-logs.js";

const owner = { spaceId: "space-1", userId: "user-1" };
const stranger = { spaceId: "space-1", userId: "user-2" };

function fakePrisma() {
  const rows = [
    {
      seq: 7n,
      runId: "run-1",
      threadId: "thread-1",
      lane: "interactive",
      level: "info",
      code: "tool.end",
      tool: "shell",
      ok: true,
      ms: 20,
      summary: null,
      createdAt: new Date(),
    },
  ];
  return {
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: string } }) =>
          where.id === "bot-1" && where.userId === "user-1" && where.spaceId === "space-1"
            ? { id: "bot-1" }
            : null,
      ),
    },
    botRuntimeLog: {
      findMany: vi.fn(async ({ where }: { where: { seq?: { gt?: bigint } } }) =>
        rows.filter((row) => where.seq?.gt === undefined || row.seq > where.seq.gt),
      ),
    },
    run: {
      findMany: vi.fn(async () => [
        {
          id: "run-1",
          lane: "interactive",
          trigger: "user",
          status: "failed",
          error: "upstream said Bearer sk-or-v1-abcdefghijklmnop",
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        },
      ]),
    },
    backgroundTask: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
}

afterEach(() => vi.unstubAllEnvs());

describe("bot live logs API", () => {
  it("reports disabled without touching the database when the flag is off", async () => {
    vi.stubEnv("RAKAZO_BOT_LIVE_LOGS", "");
    const prisma = fakePrisma();
    await expect(botRuntimeLogsPage(prisma, owner, { botId: "bot-1", limit: 50 })).resolves.toEqual(
      { enabled: false, entries: [], cursor: -1, runs: [], backgroundTasks: [] },
    );
    expect(prisma.bot.findFirst).not.toHaveBeenCalled();
    const stream = streamBotRuntimeLogs({
      prisma,
      actor: owner,
      input: { botId: "bot-1", cursor: -1 },
      heartbeatMs: 1_000,
      recheckMs: 1_000,
    });
    await expect(stream.next()).rejects.toThrow("Live logs are off.");
  });

  it("serves only the bot's owner and redacts run errors", async () => {
    vi.stubEnv("RAKAZO_BOT_LIVE_LOGS", "1");
    const prisma = fakePrisma();
    await expect(
      botRuntimeLogsPage(prisma, stranger, { botId: "bot-1", limit: 50 }),
    ).rejects.toBeInstanceOf(IsolationError);
    const page = await botRuntimeLogsPage(prisma, owner, { botId: "bot-1", limit: 50 });
    expect(page.enabled).toBe(true);
    expect(page.cursor).toBe(7);
    expect(page.entries[0]).toMatchObject({ seq: 7, code: "tool.end", tool: "shell" });
    expect(page.runs[0]!.error).not.toContain("sk-or-v1");

    const denied = streamBotRuntimeLogs({
      prisma,
      actor: stranger,
      input: { botId: "bot-1", cursor: -1 },
      heartbeatMs: 1_000,
      recheckMs: 1_000,
    });
    await expect(denied.next()).rejects.toBeInstanceOf(IsolationError);
  });

  it("streams appended lines and heartbeats while idle", async () => {
    vi.stubEnv("RAKAZO_BOT_LIVE_LOGS", "1");
    const prisma = fakePrisma();
    const abort = new AbortController();
    const stream = streamBotRuntimeLogs({
      prisma,
      actor: owner,
      input: { botId: "bot-1", cursor: -1 },
      signal: abort.signal,
      heartbeatMs: 20,
      recheckMs: 60_000,
    });
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "bot.log.append", entry: { seq: 7 } });
    const second = await stream.next();
    expect(second.value).toMatchObject({ type: "heartbeat" });
    abort.abort();
    await stream.return(undefined);
  });
});
