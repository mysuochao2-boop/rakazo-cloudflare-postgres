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
  let cause: unknown;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await target.fetch(`http://container${readinessPath}`);
      if (response.ok) return;
      cause = new Error(`readiness check returned ${response.status}`);
    } catch (error) {
      cause = error;
    }
    await scheduler.wait(200);
  }
  throw new Error("Container did not become ready", { cause });
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
    const container = await this.readyContainer();
    return container.getTcpPort(this.options.port).fetch(forwardRequest(request));
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
}

/**
 * One Durable Object per bot. Dispatch is accepted durably (DO storage) and
 * answered with 202 immediately; container start, readiness, and the hand-off
 * to the runtime happen in the background with second-level alarm retries.
 * Duplicate delivery is harmless: the runtime answers 202 for its active run
 * and the executor's fenced lease claim lets only one worker run a given run.
 */
export class BotRuntimeContainer extends DurableObject<CloudflareEnv> {
  private draining: Promise<void> | undefined;

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
    this.draining ??= this.deliverPending().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async deliverPending(): Promise<void> {
    const botId = await this.ctx.storage.get<string>("botId");
    let queue = await this.pending();
    if (!botId || queue.length === 0) return;
    let retryInMs: number | undefined;
    try {
      const container = await this.ensureRuntime(botId, queue[0]?.runId);
      while (queue.length > 0) {
        const next = queue[0]!;
        const response = await container
          .getTcpPort(BOT_RUNTIME_PORT)
          .fetch(`http://container/runs/${encodeURIComponent(next.runId)}/continue`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.env.RUNTIME_DISPATCH_SECRET}` },
          });
        await response.body?.cancel();
        if (response.status === 409) {
          // Another run is active on this bot; /finished drains again, alarm is a backstop.
          retryInMs = 5_000;
          break;
        }
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
        await this.ctx.container.setInactivityTimeout(BOT_RUNTIME_IDLE_TIMEOUT_MS);
      }
      if ((await this.pending()).length > 0) this.ctx.waitUntil(this.drain());
      return new Response(null, { status: 204 });
    }

    const botId = await this.identify(request);
    if (url.pathname === "/warm") {
      const container = await this.ensureRuntime(botId);
      // Busy timeout is only for runs; a warm ping keeps the idle window.
      if ((await this.pending()).length === 0) {
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
