import { describe, expect, it, vi } from "vitest";
import { BotRuntimeContainer } from "./container.js";
import type { CloudflareEnv } from "./env.js";

function fixture(statuses: number[]) {
  const stored = new Map<string, unknown>();
  const waits: Promise<unknown>[] = [];
  const alarms: number[] = [];
  const continueFetch = vi.fn(async (input: string) => {
    if (input.endsWith("/health")) return Response.json({ ok: true });
    return Response.json({}, { status: statuses.shift() ?? 202 });
  });
  const container = {
    running: false,
    images: { runtime: "img" },
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: () => ({ fetch: continueFetch }),
  };
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => stored.set(key, value),
      setAlarm: async (at: number) => alarms.push(at),
    },
    container,
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  } as unknown as DurableObjectState;
  const env = { RUNTIME_DISPATCH_SECRET: "s", API_URL: "https://x.example" } as CloudflareEnv;
  const runtime = new BotRuntimeContainer(ctx, env);
  const dispatch = (runId: string) =>
    runtime.fetch(
      new Request(`https://runtime.internal/runs/${runId}/continue`, {
        method: "POST",
        headers: { "x-rakazo-bot-id": "bot-1" },
      }),
    );
  return { runtime, stored, waits, alarms, continueFetch, container, dispatch };
}

const forwards = (calls: unknown[][]) =>
  calls.filter(([url]) => String(url).includes("/continue")).length;

describe("BotRuntimeContainer async dispatch", () => {
  it("accepts immediately and forwards in the background", async () => {
    const f = fixture([202]);
    const response = await f.dispatch("run-1");
    expect(response.status).toBe(202);
    await Promise.all(f.waits);
    expect(f.container.start).toHaveBeenCalledTimes(1);
    expect(forwards(f.continueFetch.mock.calls)).toBe(1);
    expect(f.stored.get("pendingRuns")).toEqual([]);
  });

  it("deduplicates repeated dispatches of the same run", async () => {
    const f = fixture([202, 202]);
    await f.dispatch("run-1");
    await f.dispatch("run-1");
    await Promise.all(f.waits);
    expect(forwards(f.continueFetch.mock.calls)).toBe(1);
  });

  it("keeps a run pending while another run is active and retries on alarm", async () => {
    const f = fixture([409, 202]);
    await f.dispatch("run-2");
    await Promise.all(f.waits);
    expect((f.stored.get("pendingRuns") as unknown[]).length).toBe(1);
    expect(f.alarms.length).toBeGreaterThan(1);
    await f.runtime.alarm();
    expect(f.stored.get("pendingRuns")).toEqual([]);
  });

  it("retries after a runtime error", async () => {
    const f = fixture([500, 202]);
    await f.dispatch("run-3");
    await Promise.all(f.waits);
    expect((f.stored.get("pendingRuns") as { attempts: number }[])[0]?.attempts).toBe(1);
    await f.runtime.alarm();
    expect(f.stored.get("pendingRuns")).toEqual([]);
  });
});
