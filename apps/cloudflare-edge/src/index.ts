import { computerGatewayRequest, computerScreenRequest } from "./computer-gateway.js";
import type { CloudflareEnv } from "./env.js";
import { bearerAuthorized } from "./internal-auth.js";
import { objectGatewayRequest } from "./object-gateway.js";
import { readBodyWithLimit, readJsonWithLimit } from "./request-body.js";
import { replicaCount, requestReplica } from "./routing.js";

export { ComputerContainer } from "./computer-container.js";
export { ApiContainer, BotRuntimeContainer, SchedulerContainer } from "./container.js";
export { RealtimeHub } from "./realtime-hub.js";

interface RuntimeCommand {
  botId: string;
  runId: string;
}

// Bump only when a deployed Container generation leaves Durable Object
// instances unable to restart. The database owns run state; this object stores
// only the bot-id fence, so a new generation safely gets a fresh Container.
const API_CONTAINER_GENERATION = "v9";
const SCHEDULER_CONTAINER_GENERATION = "v5";
const BOT_RUNTIME_GENERATION = "v15";
// Bounded keep-warm: only bots with a dispatch in the last WARM_WINDOW_MS,
// at most WARM_MAX_BOTS of them, are pinged by the cron.
const WARM_PREFIX = "__edge/warm-bots/";
const WARM_WINDOW_MS = 3 * 60 * 60 * 1000;
const WARM_MAX_BOTS = 4;

function runtimeCommand(value: unknown): RuntimeCommand | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeCommand>;
  if (
    typeof candidate.botId !== "string" ||
    !candidate.botId ||
    candidate.botId.length > 200 ||
    typeof candidate.runId !== "string" ||
    !candidate.runId ||
    candidate.runId.length > 200
  ) {
    return null;
  }
  return { botId: candidate.botId, runId: candidate.runId };
}

async function runtimeRequest(
  request: Request,
  env: CloudflareEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const receivedAt = Date.now();
  if (!bearerAuthorized(request, env.RUNTIME_DISPATCH_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await readJsonWithLimit(request, 8 * 1024);
  if (!body.ok) {
    return Response.json(
      { error: body.status === 413 ? "request_too_large" : "invalid_request" },
      { status: body.status },
    );
  }
  const command = runtimeCommand(body.value);
  if (!command) return Response.json({ error: "invalid_request" }, { status: 400 });
  const runtime = env.BOT_RUNTIME_CONTAINERS.getByName(
    `${BOT_RUNTIME_GENERATION}:${command.botId}`,
  );
  const headers = new Headers({
    authorization: `Bearer ${env.RUNTIME_DISPATCH_SECRET}`,
    "x-rakazo-bot-id": command.botId,
  });
  if (new URL(request.url).pathname === "/__runtime/finished") {
    // Multi-lane runtimes report how many runs are still active (other lanes / heartbeat).
    const activeRuns = (body.value as { activeRuns?: unknown }).activeRuns;
    if (typeof activeRuns === "number" && Number.isFinite(activeRuns) && activeRuns > 0) {
      headers.set("x-rakazo-active-runs", String(Math.min(Math.floor(activeRuns), 16)));
    }
    return runtime.fetch("https://runtime.internal/finished", { method: "POST", headers });
  }
  ctx?.waitUntil(
    env.OBJECT_STORE.put(`${WARM_PREFIX}${command.botId}`, String(Date.now())).catch(
      () => undefined,
    ),
  );
  const response = await runtime.fetch(
    `https://runtime.internal/runs/${encodeURIComponent(command.runId)}/continue`,
    { method: "POST", headers },
  );
  console.log(
    JSON.stringify({
      rakazo_timing: "edge.dispatch_returned",
      ts: new Date().toISOString(),
      botId: command.botId,
      runId: command.runId,
      status: response.status,
      ms: Date.now() - receivedAt,
    }),
  );
  return response;
}

async function warmRecentBots(env: CloudflareEnv): Promise<void> {
  const listed = await env.OBJECT_STORE.list({ prefix: WARM_PREFIX, limit: 100 });
  const now = Date.now();
  const recent = listed.objects
    .map((object) => ({
      botId: object.key.slice(WARM_PREFIX.length),
      at: object.uploaded.getTime(),
    }))
    .filter((item) => item.botId && now - item.at <= WARM_WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, WARM_MAX_BOTS);
  await Promise.allSettled(
    recent.map(async ({ botId }) => {
      const startedAt = Date.now();
      const response = await env.BOT_RUNTIME_CONTAINERS.getByName(
        `${BOT_RUNTIME_GENERATION}:${botId}`,
      ).fetch("https://runtime.internal/warm", {
        method: "POST",
        headers: { "x-rakazo-bot-id": botId },
      });
      console.log(
        JSON.stringify({
          rakazo_timing: "edge.warm_bot",
          ts: new Date().toISOString(),
          botId,
          status: response.status,
          ms: Date.now() - startedAt,
        }),
      );
    }),
  );
}

async function warmApis(env: CloudflareEnv): Promise<void> {
  const count = replicaCount(env.API_CONTAINER_REPLICAS, "API_CONTAINER_REPLICAS", 4);
  await Promise.allSettled(
    Array.from({ length: count }, async (_, index) => {
      const startedAt = Date.now();
      const response = await env.API_CONTAINERS.getByName(
        `${API_CONTAINER_GENERATION}:api-${index}`,
      ).fetch("https://api.internal/ready");
      console.log(
        JSON.stringify({
          rakazo_timing: "edge.warm_api",
          ts: new Date().toISOString(),
          replica: index,
          status: response.status,
          ms: Date.now() - startedAt,
        }),
      );
    }),
  );
}

async function realtimeRequest(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!bearerAuthorized(request, env.REALTIME_FANOUT_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const path = new URL(request.url).pathname.endsWith("/connect") ? "/connect" : "/publish";
  const url = new URL(request.url);
  url.pathname = path;
  if (request.method === "GET") {
    return env.REALTIME_HUB.getByName("global").fetch(new Request(url, request));
  }
  const body = await readBodyWithLimit(request, 132 * 1024);
  if (!body.ok) {
    return Response.json(
      { error: body.status === 413 ? "request_too_large" : "invalid_request" },
      { status: body.status },
    );
  }
  return env.REALTIME_HUB.getByName("global").fetch(
    new Request(url, {
      method: "POST",
      headers: request.headers,
      body: new TextDecoder().decode(body.bytes),
    }),
  );
}

async function ensureSchedulers(env: CloudflareEnv): Promise<void> {
  const count = replicaCount(env.SCHEDULER_CONTAINER_REPLICAS, "SCHEDULER_CONTAINER_REPLICAS", 2);
  const responses = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      env.SCHEDULER_CONTAINERS.getByName(
        `${SCHEDULER_CONTAINER_GENERATION}:scheduler-${index}`,
      ).fetch("https://scheduler.internal/health"),
    ),
  );
  for (const response of responses) {
    if (!response.ok) throw new Error(`Scheduler readiness returned ${response.status}`);
  }
}

function isApiPath(pathname: string): boolean {
  return ["/api", "/rpc", "/health", "/ready", "/internal", "/novnc", "/.well-known"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__edge/health") {
      return Response.json({ ok: true });
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/__runtime/dispatch" || url.pathname === "/__runtime/finished")
    ) {
      return runtimeRequest(request, env, ctx);
    }
    if (
      (request.method === "POST" && url.pathname === "/__realtime/publish") ||
      (request.method === "GET" && url.pathname === "/__realtime/connect")
    ) {
      return realtimeRequest(request, env);
    }
    if (url.pathname.startsWith("/__objects/")) return objectGatewayRequest(request, env);
    if (url.pathname.startsWith("/__computers/")) return computerGatewayRequest(request, env);
    if (url.pathname.startsWith("/novnc/session/")) {
      const count = replicaCount(env.API_CONTAINER_REPLICAS, "API_CONTAINER_REPLICAS", 4);
      const replica = requestReplica(request, count);
      return computerScreenRequest(request, env, `${API_CONTAINER_GENERATION}:api-${replica}`);
    }
    if (
      url.pathname.startsWith("/__runtime/") ||
      url.pathname.startsWith("/__realtime/") ||
      url.pathname.startsWith("/__objects/") ||
      url.pathname.startsWith("/__computers/")
    ) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/__edge/")) return new Response("Not found", { status: 404 });

    if ((request.method === "GET" || request.method === "HEAD") && !isApiPath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    const count = replicaCount(env.API_CONTAINER_REPLICAS, "API_CONTAINER_REPLICAS", 4);
    const replica = requestReplica(request, count);
    return env.API_CONTAINERS.getByName(`${API_CONTAINER_GENERATION}:api-${replica}`).fetch(
      request,
    );
  },

  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(ensureSchedulers(env));
    ctx.waitUntil(warmApis(env));
    ctx.waitUntil(warmRecentBots(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
