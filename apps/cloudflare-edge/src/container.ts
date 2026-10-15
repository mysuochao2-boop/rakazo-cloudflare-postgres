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
    inactivityTimeoutMs: 10 * 60 * 1000,
    port: 3100,
    readinessPath: "/ready",
    runtimeEnv: apiContainerEnv,
  };
}

export class SchedulerContainer extends ManagedContainer {
  protected readonly options: ManagedContainerOptions = {
    inactivityTimeoutMs: 15 * 60 * 1000,
    port: 3200,
    readinessPath: "/health",
    runtimeEnv: schedulerContainerEnv,
  };
}

export class BotRuntimeContainer extends DurableObject<CloudflareEnv> {
  private async identify(request: Request): Promise<string> {
    const requested = request.headers.get("x-rakazo-bot-id");
    if (!requested) throw new Error("Bot identity is required");
    const existing = await this.ctx.storage.get<string>("botId");
    if (existing && existing !== requested) throw new Error("Bot runtime identity mismatch");
    if (!existing) await this.ctx.storage.put("botId", requested);
    return requested;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/finished") {
      if (this.ctx.container?.running) {
        await this.ctx.container.setInactivityTimeout(5 * 60 * 1000);
      }
      return new Response(null, { status: 204 });
    }

    const botId = await this.identify(request);
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding is unavailable");
    if (!container.running) {
      container.start({
        image: container.images.runtime,
        instance: "standard-1",
        enableInternet: true,
        env: botRuntimeContainerEnv(this.env, botId),
      });
    }
    await container.setInactivityTimeout(60 * 60 * 1000);
    await waitUntilReady(container, 3300, "/health");
    return container.getTcpPort(3300).fetch(forwardRequest(request));
  }
}
