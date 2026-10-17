import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { RuntimeLogEntry } from "@rakazo/core";
import { setRuntimeLogTap } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRuntimeServer } from "./runtime-server.js";
import { startBotRuntimeServer } from "./runtime-server.js";

let server: BotRuntimeServer | undefined;

afterEach(async () => {
  setRuntimeLogTap(undefined);
  await server?.close();
  server = undefined;
});

function handlers(run: (payload: { runId: string }) => Promise<void>): BackgroundJobHandlers {
  return new Proxy(
    { "run.continue": run },
    { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
  ) as unknown as BackgroundJobHandlers;
}

describe("bot runtime server", () => {
  it("authenticates and starts only runs owned by its bot", async () => {
    const run = vi.fn(async () => undefined);
    server = await startBotRuntimeServer({
      botId: "bot-1",
      host: "127.0.0.1",
      port: 0,
      token: "runtime-secret",
      prisma: {
        run: { findUnique: vi.fn(async () => ({ botId: "bot-1" })) },
      } as unknown as PrismaClient,
      handlers: handlers(run),
      logger: { error: vi.fn() } as unknown as Logger,
    });
    const url = `http://127.0.0.1:${server.port}/runs/run-1/continue`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer runtime-secret" },
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ runId: "run-1" }));
  });

  it("rejects a run belonging to another bot", async () => {
    const run = vi.fn(async () => undefined);
    server = await startBotRuntimeServer({
      botId: "bot-1",
      host: "127.0.0.1",
      port: 0,
      token: "runtime-secret",
      prisma: {
        run: { findUnique: vi.fn(async () => ({ botId: "bot-2" })) },
      } as unknown as PrismaClient,
      handlers: handlers(run),
      logger: { error: vi.fn() } as unknown as Logger,
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/runs/run-1/continue`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-secret" },
    });
    expect(response.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs interactive and background lanes concurrently and 409s only a full lane", async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const lanes: Record<string, string> = {
      "bg-1": "background",
      "bg-2": "background",
      "bg-3": "background",
      "int-1": "interactive",
      "int-2": "interactive",
    };
    server = await startBotRuntimeServer({
      botId: "bot-1",
      host: "127.0.0.1",
      port: 0,
      token: "runtime-secret",
      backgroundLanes: 2,
      prisma: {
        run: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
            botId: "bot-1",
            lane: lanes[where.id],
          })),
        },
      } as unknown as PrismaClient,
      handlers: handlers(run),
      logger: { error: vi.fn() } as unknown as Logger,
    });
    const post = async (id: string) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/runs/${id}/continue`, {
        method: "POST",
        headers: { authorization: "Bearer runtime-secret" },
      });
      return { status: response.status, body: (await response.json()) as { lane?: string } };
    };
    expect((await post("bg-1")).status).toBe(202);
    expect((await post("bg-2")).status).toBe(202);
    const full = await post("bg-3");
    expect(full.status).toBe(409);
    expect(full.body.lane).toBe("background");
    expect((await post("int-1")).status).toBe(202);
    const busy = await post("int-2");
    expect(busy.status).toBe(409);
    expect(busy.body.lane).toBe("interactive");
    // Re-delivery of an active run is accepted, not rejected.
    expect((await post("bg-1")).status).toBe(202);
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
    expect(health).toMatchObject({
      activeRunId: "int-1",
      lanes: { interactive: ["int-1"], background: ["bg-1", "bg-2"] },
    });
    for (const release of releases) release();
  });

  it("reports accepted runs, busy lanes, and run errors to live logs", async () => {
    const logged: RuntimeLogEntry[] = [];
    setRuntimeLogTap((entry) => logged.push(entry));
    let release: (() => void) | undefined;
    const run = vi.fn(async ({ runId }: { runId: string }) => {
      if (runId === "int-fail") throw new Error("model failed token=abc");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    server = await startBotRuntimeServer({
      botId: "bot-1",
      host: "127.0.0.1",
      port: 0,
      token: "runtime-secret",
      backgroundLanes: 1,
      prisma: {
        run: {
          findUnique: vi.fn(async () => ({ botId: "bot-1", lane: "interactive" })),
        },
      } as unknown as PrismaClient,
      handlers: handlers(run),
      logger: { error: vi.fn() } as unknown as Logger,
    });
    const post = (id: string) =>
      fetch(`http://127.0.0.1:${server!.port}/runs/${id}/continue`, {
        method: "POST",
        headers: { authorization: "Bearer runtime-secret" },
      });
    expect((await post("int-fail")).status).toBe(202);
    await vi.waitFor(() => expect(logged.some((entry) => entry.code === "run.error")).toBe(true));
    expect((await post("int-1")).status).toBe(202);
    expect((await post("int-2")).status).toBe(409);
    expect(logged.map((entry) => [entry.code, entry.runId, entry.lane ?? null])).toEqual([
      ["runtime.accepted", "int-fail", "interactive"],
      ["run.error", "int-fail", null],
      ["runtime.accepted", "int-1", "interactive"],
      ["runtime.lane_busy", "int-2", "interactive"],
    ]);
    release?.();
  });
});
