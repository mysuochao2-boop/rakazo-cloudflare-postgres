import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  botRuntimeLogTopic,
  createBotRuntimeLogWriter,
  followBotRuntimeLogs,
  listBotRuntimeLogs,
  redactRuntimeLogText,
  sanitizeRuntimeLogEntry,
} from "./bot-runtime-logs.js";
import type { PrismaClient } from "./client.js";

type Row = {
  seq: bigint;
  spaceId: string;
  botId: string;
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

class TestFanout implements RealtimeFanout {
  published: Array<{ topic: string; payload: string }> = [];
  listeners = new Map<string, (payload: string) => void>();
  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }
  async publish(topic: string, payload: string) {
    this.published.push({ topic, payload });
    this.listeners.get(topic)?.(payload);
  }
  async subscribe(topic: string, listener: (payload: string) => void) {
    this.listeners.set(topic, listener);
    return async () => {
      this.listeners.delete(topic);
    };
  }
  async close() {}
}

function fakePrisma(options: { failInsert?: boolean } = {}) {
  const rows: Row[] = [];
  let next = 1n;
  const runs: Record<string, { spaceId: string; botId: string; threadId: string; lane: string }> = {
    "run-1": { spaceId: "space-1", botId: "bot-1", threadId: "thread-1", lane: "background" },
  };
  const threads: Record<string, { spaceId: string; botId: string | null }> = {
    "thread-1": { spaceId: "space-1", botId: "bot-1" },
    "thread-group": { spaceId: "space-1", botId: null },
  };
  const deleteMany = vi.fn(async ({ where }: { where: { createdAt: { lt: Date } } }) => {
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]!.createdAt < where.createdAt.lt) rows.splice(i, 1);
    }
    return { count: before - rows.length };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs[where.id] ?? null),
    },
    thread: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => threads[where.id] ?? null),
    },
    botRuntimeLog: {
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Omit<Row, "seq">> }) => {
        if (options.failInsert) throw new Error("db down");
        return data.map((row) => {
          const stored = { ...row, seq: next++ };
          rows.push(stored);
          return { seq: stored.seq, botId: stored.botId };
        });
      }),
      deleteMany,
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: {
            botId: string;
            seq?: { gt?: bigint; lt?: bigint };
            runId?: string;
            createdAt?: { gte: Date };
          };
          orderBy: { seq: "asc" | "desc" };
          take: number;
        }) => {
          const matched = rows.filter(
            (row) =>
              row.botId === where.botId &&
              (where.seq?.gt === undefined || row.seq > where.seq.gt) &&
              (where.seq?.lt === undefined || row.seq < where.seq.lt) &&
              (!where.runId || row.runId === where.runId) &&
              (!where.createdAt || row.createdAt >= where.createdAt.gte),
          );
          matched.sort((a, b) => (a.seq < b.seq ? -1 : 1));
          if (orderBy.seq === "desc") matched.reverse();
          return matched.slice(0, take);
        },
      ),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows, raw: prisma };
}

describe("sanitizeRuntimeLogEntry", () => {
  it("redacts secrets, credentials in URLs, and inline images", () => {
    const text = redactRuntimeLogText(
      "connect postgres://admin:hunter2@db.internal:5432/app failed Bearer abc.def token=xyz data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA sk-or-v1-1234567890abcdef",
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("xyz");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text).not.toContain("sk-or-v1");
    expect(text).toContain("postgres://[redacted]@db.internal");
  });

  it("drops entries without a safe code and normalizes fields", () => {
    expect(sanitizeRuntimeLogEntry({ code: "not a code; rm -rf" })).toBeNull();
    expect(
      sanitizeRuntimeLogEntry({
        code: "tool.end",
        tool: "weird tool name with spaces",
        ms: 12.7,
        lane: "other",
        runId: "run-1",
        level: "error",
        summary: "   ",
      }),
    ).toEqual({
      code: "tool.end",
      level: "error",
      runId: "run-1",
      threadId: null,
      lane: null,
      ms: 13,
      tool: "[tool]",
      ok: null,
      summary: null,
    });
  });
});

describe("createBotRuntimeLogWriter", () => {
  it("resolves the bot from the run, batches inserts, and publishes the cursor", async () => {
    const { prisma, rows, raw } = fakePrisma();
    const realtime = new TestFanout();
    const writer = createBotRuntimeLogWriter(prisma, realtime, { flushMs: 10_000 });
    writer.tap({ code: "tool.start", runId: "run-1", tool: "shell" });
    writer.tap({ code: "tool.end", runId: "run-1", tool: "shell", ok: true, ms: 40 });
    writer.tap({ code: "send.received", threadId: "thread-1" });
    writer.tap({ code: "send.received", threadId: "thread-group" });
    writer.tap({ code: "orphan" });
    await writer.flush();

    expect(raw.botRuntimeLog.createManyAndReturn).toHaveBeenCalledOnce();
    expect(raw.run.findUnique).toHaveBeenCalledOnce();
    expect(rows.map((row) => [row.code, row.botId, row.lane])).toEqual([
      ["tool.start", "bot-1", "background"],
      ["tool.end", "bot-1", "background"],
      ["send.received", "bot-1", null],
    ]);
    expect(realtime.published).toEqual([
      { topic: botRuntimeLogTopic("bot-1"), payload: JSON.stringify({ cursor: 3 }) },
    ]);
    await writer.close();
  });

  it("never throws when the database is unavailable and bounds the queue", async () => {
    const { prisma } = fakePrisma({ failInsert: true });
    const writer = createBotRuntimeLogWriter(prisma, undefined, {
      flushMs: 10_000,
      maxQueue: 2,
      maxBatch: 10,
    });
    writer.tap({ code: "a", runId: "run-1" });
    writer.tap({ code: "b", runId: "run-1" });
    writer.tap({ code: "c", runId: "run-1" });
    await expect(writer.flush()).resolves.toBeUndefined();
    await writer.close();
  });

  it("prunes rows older than the retention window", async () => {
    let now = Date.UTC(2026, 9, 17);
    const { prisma, rows } = fakePrisma();
    const writer = createBotRuntimeLogWriter(prisma, undefined, {
      flushMs: 10_000,
      retentionMs: 1_000,
      pruneEveryMs: 0,
      now: () => now,
    });
    writer.tap({ code: "old", runId: "run-1" });
    await writer.flush();
    now += 5_000;
    writer.tap({ code: "new", runId: "run-1" });
    await writer.flush();
    expect(rows.map((row) => row.code)).toEqual(["new"]);
    await writer.close();
  });
});

describe("reading bot runtime logs", () => {
  it("lists newest pages oldest-first and follows new lines after a publish", async () => {
    const { prisma } = fakePrisma();
    const realtime = new TestFanout();
    const writer = createBotRuntimeLogWriter(prisma, realtime, { flushMs: 10_000 });
    for (const code of ["one", "two", "three"]) writer.tap({ code, runId: "run-1" });
    await writer.flush();

    const page = await listBotRuntimeLogs(prisma, { botId: "bot-1", limit: 2 });
    expect(page.map((line) => line.code)).toEqual(["two", "three"]);
    const older = await listBotRuntimeLogs(prisma, { botId: "bot-1", limit: 2, before: 2 });
    expect(older.map((line) => line.code)).toEqual(["one"]);

    const abort = new AbortController();
    const follow = followBotRuntimeLogs(prisma, "bot-1", 3, realtime, abort.signal, 60_000);
    const next = follow.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    writer.tap({ code: "four", runId: "run-1", ms: 5 });
    await writer.flush();
    const result = await next;
    expect(result.value).toMatchObject({ seq: 4, code: "four", ms: 5, lane: "background" });
    abort.abort();
    await follow.return(undefined);
    await writer.close();
  });
});
