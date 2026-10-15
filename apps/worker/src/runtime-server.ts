import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";

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
}): Promise<BotRuntimeServer> {
  let active: { runId: string; task: Promise<void> } | undefined;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runtime.internal");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, activeRunId: active?.runId ?? null });
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
      if (active) {
        json(response, active.runId === runId ? 202 : 409, {
          accepted: active.runId === runId,
          activeRunId: active.runId,
        });
        return;
      }
      const run = await options.prisma.run.findUnique({
        where: { id: runId },
        select: { botId: true },
      });
      if (!run) {
        json(response, 404, { error: "run_not_found" });
        return;
      }
      if (run.botId !== options.botId) {
        json(response, 409, { error: "bot_mismatch" });
        return;
      }

      const task = options.handlers["run.continue"]({ runId })
        .catch((error) => options.logger.error("bot runtime execution failed", error, { runId }))
        .finally(async () => {
          active = undefined;
          if (options.callbackUrl) {
            await notifyFinished(options.callbackUrl, options.token, options.botId, runId).catch(
              (error) =>
                options.logger.error("bot runtime completion callback failed", error, { runId }),
            );
          }
        });
      active = { runId, task };
      json(response, 202, { accepted: true, runId });
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
      if (active && options.abortRun) await options.abortRun(active.runId).catch(() => undefined);
      await Promise.all([closed, active?.task]);
    },
  };
}

async function notifyFinished(
  callbackUrl: string,
  token: string,
  botId: string,
  runId: string,
): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ botId, runId }),
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
