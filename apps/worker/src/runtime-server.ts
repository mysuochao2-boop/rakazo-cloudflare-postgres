import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import { backgroundLaneCapacity, RuntimeLaneSlots } from "./runtime-lanes.js";

export interface BotRuntimeServer {
  port: number;
  close(): Promise<void>;
}

export async function startBotRuntimeServer(options: {
  botId: string;
  host: string;
  port: number;
  token: string;
  prisma: PrismaClient;
  handlers: BackgroundJobHandlers;
  logger: Logger;
  callbackUrl?: string;
  abortRun?: (runId: string) => Promise<void>;
  /** Background lane slots; default from RAKAZO_BACKGROUND_TASKS (0 = single shared slot). */
  backgroundLanes?: number;
  heartbeatMs?: number;
}): Promise<BotRuntimeServer> {
  const slots = new RuntimeLaneSlots<Promise<void>>(
    options.backgroundLanes ?? backgroundLaneCapacity(process.env),
  );
  // Long background runs outlive the edge's busy timeout unless the runtime reports in.
  const heartbeat = setInterval(
    () => {
      const occupancy = slots.occupancy();
      const first = occupancy.background[0];
      if (!first || !options.callbackUrl) return;
      void notifyFinished(
        options.callbackUrl,
        options.token,
        options.botId,
        first,
        slots.active.size,
      ).catch((error) => options.logger.error("bot runtime heartbeat failed", error));
    },
    options.heartbeatMs ?? 10 * 60_000,
  );
  heartbeat.unref?.();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runtime.internal");
      if (request.method === "GET" && url.pathname === "/health") {
        const occupancy = slots.occupancy();
        json(response, 200, {
          ok: true,
          activeRunId: occupancy.interactive[0] ?? occupancy.background[0] ?? null,
          lanes: occupancy,
        });
        return;
      }
      const match = /^\/runs\/([^/]+)\/continue$/.exec(url.pathname);
      if (request.method !== "POST" || !match) {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request.headers.authorization, options.token)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const runId = decodeURIComponent(match[1]!);
      if (slots.has(runId)) {
        json(response, 202, { accepted: true, activeRunId: runId });
        return;
      }
      const run = await options.prisma.run.findUnique({
        where: { id: runId },
        select: { botId: true, lane: true },
      });
      if (!run) {
        json(response, 404, { error: "run_not_found" });
        return;
      }
      if (run.botId !== options.botId) {
        json(response, 409, { error: "bot_mismatch" });
        return;
      }
      // Acquire synchronously after the lookup so two deliveries cannot both pass.
      const acquired = slots.tryAcquire(runId, run.lane);
      if (!acquired.ok) {
        json(response, acquired.duplicate ? 202 : 409, {
          accepted: acquired.duplicate,
          lane: acquired.lane,
          activeRunId: acquired.activeRunIds[0] ?? null,
          activeRunIds: acquired.activeRunIds,
        });
        return;
      }

      const task = options.handlers["run.continue"]({ runId })
        .catch((error) => options.logger.error("bot runtime execution failed", error, { runId }))
        .finally(async () => {
          slots.release(runId);
          if (options.callbackUrl) {
            await notifyFinished(
              options.callbackUrl,
              options.token,
              options.botId,
              runId,
              slots.active.size,
            ).catch((error) =>
              options.logger.error("bot runtime completion callback failed", error, { runId }),
            );
          }
        });
      slots.attach(runId, task);
      json(response, 202, { accepted: true, runId, lane: slots.laneOf(run.lane) });
    } catch (error) {
      options.logger.error("bot runtime request failed", error);
      json(response, 500, { error: "internal_error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      clearInterval(heartbeat);
      const running = [...slots.active.values()];
      if (options.abortRun) {
        await Promise.all(
          running.map((slot) => options.abortRun!(slot.runId).catch(() => undefined)),
        );
      }
      await Promise.all([closed, ...running.map((slot) => slot.task)]);
    },
  };
}

async function notifyFinished(
  callbackUrl: string,
  token: string,
  botId: string,
  runId: string,
  activeRuns = 0,
): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // activeRuns > 0 tells the edge to keep the busy timeout (other lanes still working).
    body: JSON.stringify({ botId, runId, activeRuns }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Runtime completion callback returned ${response.status}`);
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
