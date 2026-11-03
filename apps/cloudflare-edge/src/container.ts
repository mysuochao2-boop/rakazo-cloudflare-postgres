import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "./env.js";
import { apiContainerEnv, botRuntimeContainerEnv, schedulerContainerEnv } from "./env.js";

type ContainerInstance = NonNullable<DurableObjectState["container"]>;

interface ManagedContainerOptions {
  inactivityTimeoutMs: number;
  port: number;
  readinessPath: string;
  runtimeEnv: (env: CloudflareEnv) => Record<string, string>;
}

async function waitUntilReady(
  container: ContainerInstance,
  port: number,
  readinessPath: string,
): Promise<void> {
  const target = container.getTcpPort(port);
  const deadline = Date.now() + 45_000;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      // Bound each probe: a probe that hangs instead of erroring would
      // otherwise stall the whole gate (and every request behind it)
      // forever, in front of the per-request header deadline below.
      const response = await target.fetch(`http://container${readinessPath}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      cause = new Error(`readiness check returned ${response.status}`);
    } catch (error) {
      cause = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await scheduler.wait(Math.min(200, remaining));
  }
  throw new Error("Container did not become ready", { cause });
}

/** Deadline while the container has accepted the request but sent nothing yet. */
const API_HEADER_TIMEOUT_MS = 20_000;

/**
 * Streams that must never carry an edge-side header deadline: oRPC event
 * iterators (threads/logs subscribe) and the /novnc websocket tunnel. The
 * client aborts both with its own signal.
 */
export function isLongLivedRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/novnc/")) return true;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return true;
  if (request.headers.get("accept")?.includes("text/event-stream")) return true;
  // oRPC event iterators are the subscribe procedures under /rpc.
  return url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")
    ? url.pathname.endsWith("/subscribe")
    : false;
}

function forwardRequest(request: Request): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  forwarded.headers.delete("x-rakazo-routing-key");
  return forwarded;
}

abstract class ManagedContainer extends DurableObject<CloudflareEnv> {
  protected abstract readonly options: ManagedContainerOptions;

  private async readyContainer(): Promise<ContainerInstance> {
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding is unavailable");
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: this.options.runtimeEnv(this.env),
      });
    }
    await container.setInactivityTimeout(this.options.inactivityTimeoutMs);
    await waitUntilReady(container, this.options.port, this.options.readinessPath);
    return container;
  }

  override async fetch(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const pathname = new URL(request.url).pathname;
    const container = await this.readyContainer();
    const readyMs = Date.now() - startedAt;
    const forwarded = forwardRequest(request);
    // A container that passed readiness can still wedge on a hung DB
    // checkout. Bound only the wait for response headers: long-lived
    // streams (oRPC event iterators, /novnc websocket tunnels) keep their
    // own deadline. Once headers arrive the deadline no longer applies.
    if (isLongLivedRequest(request)) {
      return container.getTcpPort(this.options.port).fetch(forwarded);
    }
    const controller = new AbortController();
    // Lift the deadline once response headers arrive; a body stream that
    // runs long after a healthy start keeps flowing.
    let releaseDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        container.getTcpPort(this.options.port).fetch(forwarded, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          releaseDeadline = setTimeout(() => {
            controller.abort(new DOMException("upstream timeout", "TimeoutError"));
            reject(new DOMException("upstream timeout", "TimeoutError"));
          }, API_HEADER_TIMEOUT_MS);
        }),
      ]);
      const headerMs = Date.now() - startedAt - readyMs;
      if (readyMs + headerMs >= 5_000) {
        edgeTiming("edge.managed_slow", { pathname, readyMs, headerMs, status: response.status });
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        edgeTiming("edge.managed_timeout", {
          pathname,
          readyMs,
          headerMs: Date.now() - startedAt - readyMs,
        });
        return Response.json({ error: "upstream_timeout" }, { status: 504 });
      }
      throw error;
    } finally {
      if (releaseDeadline) clearTimeout(releaseDeadline);
    }
  }
}

export class ApiContainer extends ManagedContainer {
  protected readonly options: ManagedContainerOptions = {
    inactivityTimeoutMs: 30 * 60 * 1000,
    port: 3100,
    readinessPath: "/ready",
    runtimeEnv: apiContainerEnv,
  };
}

export class SchedulerContainer extends ManagedContainer {
  protected readonly options: ManagedContainerOptions = {
    inactivityTimeoutMs: 30 * 60 * 1000,
    port: 3200,
    readinessPath: "/health",
    runtimeEnv: schedulerContainerEnv,
  };
}

const BOT_RUNTIME_PORT = 3300;
const BOT_RUNTIME_BUSY_TIMEOUT_MS = 60 * 60 * 1000;
// Keep a bot's runtime warm after a turn so follow-up messages skip the 12-24 s
// cold start. The edge cron re-pings only recently active bots (bounded).
const BOT_RUNTIME_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING_KEY = "pendingRuns";
const MAX_DELIVERY_ATTEMPTS = 120;

export function edgeTiming(step: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ rakazo_timing: step, ts: new Date().toISOString(), ...fields }));
}

interface PendingRun {
  runId: string;
  acceptedAt: number;
  attempts: number;
  /** Lane learned from a runtime 409 body; absent on old stored entries (unknown). */
  lane?: string;
}

/**
 * Picks the next pending run to offer the runtime, skipping runs whose lane already
 * answered 409 in this pass. Unknown-lane runs are always offered (the runtime decides),
 * so a full background lane never blocks an interactive run queued behind it.
 */
export function nextDeliverable(
  queue: readonly PendingRun[],
  tried: ReadonlySet<string>,
  blockedLanes: ReadonlySet<string>,
): PendingRun | undefined {
  return queue.find(
    (item) => !tried.has(item.runId) && !(item.lane && blockedLanes.has(item.lane)),
  );
}

/**
 * One Durable Object per bot. Dispatch is accepted durably (DO storage) and
 * answered with 202 immediately; container start, readiness, and the hand-off
 * to the runtime happen in the background with second-level alarm retries.
 * Duplicate delivery is harmless: the runtime answers 202 for its active run
 * and the executor's fenced lease claim lets only one worker run a given run.
 */
export class BotRuntimeContainer extends DurableObject<CloudflareEnv> {
  private draining: { promise: Promise<void>; startedAt: number } | undefined;

  private async identify(request: Request): Promise<string> {
    const requested = request.headers.get("x-rakazo-bot-id");
    if (!requested) throw new Error("Bot identity is required");
    const existing = await this.ctx.storage.get<string>("botId");
    if (existing && existing !== requested) throw new Error("Bot runtime identity mismatch");
    if (!existing) await this.ctx.storage.put("botId", requested);
    return requested;
  }

  private async pending(): Promise<PendingRun[]> {
    return (await this.ctx.storage.get<PendingRun[]>(PENDING_KEY)) ?? [];
  }

  private async ensureRuntime(botId: string, runId?: string): Promise<ContainerInstance> {
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding is unavailable");
    const cold = !container.running;
    const startedAt = Date.now();
    if (cold) {
      container.start({
        image: container.images.runtime,
        instance: "standard-1",
        enableInternet: true,
        env: botRuntimeContainerEnv(this.env, botId),
      });
    }
    await container.setInactivityTimeout(BOT_RUNTIME_BUSY_TIMEOUT_MS);
    await waitUntilReady(container, BOT_RUNTIME_PORT, "/health");
    edgeTiming("edge.container_ready", { botId, runId, cold, ms: Date.now() - startedAt });
    return container;
  }

  private drain(): Promise<void> {
    // A waitUntil task can be cancelled when an isolate is evicted without its
    // Promise settling. Do not let that stale in-memory Promise fence durable
    // pending work forever after the isolate is reused.
    if (this.draining && Date.now() - this.draining.startedAt < 60_000) {
      return this.draining.promise;
    }
    const current = {
      startedAt: Date.now(),
      promise: Promise.resolve() as Promise<void>,
    };
    current.promise = this.deliverPending().finally(() => {
      if (this.draining === current) this.draining = undefined;
    });
    this.draining = current;
    return current.promise;
  }

  private async deliverPending(): Promise<void> {
    const botId = await this.ctx.storage.get<string>("botId");
    let queue = await this.pending();
    if (!botId || queue.length === 0) return;
    let retryInMs: number | undefined;
    try {
      const container = await this.ensureRuntime(botId, queue[0]?.runId);
      const tried = new Set<string>();
      const blockedLanes = new Set<string>();
      for (;;) {
        // Re-read so runs accepted during this pass are offered too.
        queue = await this.pending();
        const next = nextDeliverable(queue, tried, blockedLanes);
        if (!next) break;
        tried.add(next.runId);
        const response = await container
          .getTcpPort(BOT_RUNTIME_PORT)
          .fetch(`http://container/runs/${encodeURIComponent(next.runId)}/continue`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.env.RUNTIME_DISPATCH_SECRET}` },
          });
        if (response.status === 409) {
          // That run's lane is busy; /finished drains again, alarm is a backstop. Keep
          // offering other runs: a busy lane must not block the rest of the queue.
          const lane = await response
            .json<{ lane?: unknown }>()
            .then((body) => (typeof body.lane === "string" ? body.lane : undefined))
            .catch(() => undefined);
          blockedLanes.add(lane ?? "interactive");
          if (lane && next.lane !== lane) {
            await this.ctx.storage.put(
              PENDING_KEY,
              (await this.pending()).map((item) =>
                item.runId === next.runId ? { ...item, lane } : item,
              ),
            );
          }
          retryInMs = 5_000;
          continue;
        }
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) {
          throw new Error(`runtime continue returned ${response.status}`);
        }
        edgeTiming("edge.run_forwarded", {
          botId,
          runId: next.runId,
          status: response.status,
          queuedMs: Date.now() - next.acceptedAt,
          attempts: next.attempts + 1,
        });
        queue = (await this.pending()).filter((item) => item.runId !== next.runId);
        await this.ctx.storage.put(PENDING_KEY, queue);
      }
    } catch (error) {
      queue = (await this.pending())
        .map((item) => ({ ...item, attempts: item.attempts + 1 }))
        .filter((item) => {
          if (item.attempts < MAX_DELIVERY_ATTEMPTS) return true;
          // The run is durable in Postgres; the scheduler reconciler re-dispatches it.
          edgeTiming("edge.run_dropped", { botId, runId: item.runId, attempts: item.attempts });
          return false;
        });
      await this.ctx.storage.put(PENDING_KEY, queue);
      edgeTiming("edge.dispatch_retry", {
        botId,
        runId: queue[0]?.runId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      retryInMs = Math.min(2_000 * 2 ** Math.min(queue[0]?.attempts ?? 0, 3), 15_000);
    }
    if (queue.length > 0) await this.ctx.storage.setAlarm(Date.now() + (retryInMs ?? 3_000));
  }

  override async alarm(): Promise<void> {
    await this.drain();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/finished") {
      if (this.ctx.container?.running) {
        // Another lane (or a heartbeat) still has work: keep the busy window.
        const stillActive = Number(request.headers.get("x-rakazo-active-runs") ?? 0) > 0;
        await this.ctx.container.setInactivityTimeout(
          stillActive ? BOT_RUNTIME_BUSY_TIMEOUT_MS : BOT_RUNTIME_IDLE_TIMEOUT_MS,
        );
      }
      if ((await this.pending()).length > 0) this.ctx.waitUntil(this.drain());
      return new Response(null, { status: 204 });
    }

    const botId = await this.identify(request);
    if (url.pathname === "/warm") {
      const container = await this.ensureRuntime(botId);
      const pending = await this.pending();
      // A previous waitUntil drain may have been cancelled while the durable
      // queue survived. Warming a now-ready runtime must also resume that work.
      if (pending.length > 0) {
        this.ctx.waitUntil(this.drain());
      } else {
        // Busy timeout is only for runs; a warm ping keeps the idle window.
        await container.setInactivityTimeout(BOT_RUNTIME_IDLE_TIMEOUT_MS);
      }
      return new Response(null, { status: 204 });
    }

    const match = /^\/runs\/([^/]+)\/continue$/.exec(url.pathname);
    if (!match) return Response.json({ error: "not_found" }, { status: 404 });
    const runId = decodeURIComponent(match[1]!);
    const queue = await this.pending();
    if (!queue.some((item) => item.runId === runId)) {
      queue.push({ runId, acceptedAt: Date.now(), attempts: 0 });
      await this.ctx.storage.put(PENDING_KEY, queue);
    }
    edgeTiming("edge.dispatch_accepted", {
      botId,
      runId,
      cold: !this.ctx.container?.running,
      pending: queue.length,
    });
    // Backstop if this isolate is evicted before the background drain finishes.
    await this.ctx.storage.setAlarm(Date.now() + 20_000);
    this.ctx.waitUntil(this.drain());
    return Response.json({ accepted: true, queued: true, runId }, { status: 202 });
  }
}
