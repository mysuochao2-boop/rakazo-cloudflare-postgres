import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRuntimeServer } from "./runtime-server.js";
import { startBotRuntimeServer } from "./runtime-server.js";

let server: BotRuntimeServer | undefined;

afterEach(async () => {
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
});
