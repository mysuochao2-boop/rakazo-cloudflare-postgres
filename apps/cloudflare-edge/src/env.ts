export interface CloudflareEnv {
  ASSETS: Fetcher;
  API_CONTAINERS: DurableObjectNamespace;
  BOT_RUNTIME_CONTAINERS: DurableObjectNamespace;
  COMPUTER_CONTAINERS: DurableObjectNamespace;
  REALTIME_HUB: DurableObjectNamespace;
  OBJECT_STORE: R2Bucket;
  SCHEDULER_CONTAINERS: DurableObjectNamespace;
  DATABASE_URL: string;
  WORKER_DATABASE_URL: string;
  REALTIME_DATABASE_URL?: string;
  BETTER_AUTH_SECRET: string;
  ENCRYPTION_KEY: string;
  SCREEN_PROXY_SECRET: string;
  RUNTIME_DISPATCH_SECRET: string;
  REALTIME_FANOUT_SECRET: string;
  OBJECT_STORE_GATEWAY_SECRET: string;
  COMPUTER_GATEWAY_SECRET: string;
  CONTAINER_ENV_JSON?: string;
  API_CONTAINER_REPLICAS: string;
  SCHEDULER_CONTAINER_REPLICAS: string;
  API_URL: string;
  WEB_ORIGIN: string;
  /** Comma-separated hostnames the /novnc edge proxy may fetch (Hybrid VPS). */
  SCREEN_UPSTREAM_ALLOWLIST?: string;
}

const BLOCKED_ENV_KEYS = new Set([
  "AGENT_RUNTIME",
  "API_HOST",
  "API_PORT",
  "BETTER_AUTH_SECRET",
  "CLOUDFLARE_COMPUTER_SECRET",
  "CLOUDFLARE_COMPUTER_URL",
  "COMPUTER_GATEWAY_SECRET",
  "DATABASE_URL",
  "DATA_DIR",
  "ENCRYPTION_KEY",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "OBJECT_STORE_GATEWAY_SECRET",
  "OBJECT_STORE_GATEWAY_URL",
  "REALTIME_DATABASE_URL",
  "REALTIME_FANOUT_SECRET",
  "REALTIME_FANOUT_URL",
  "RUNTIME_CALLBACK_URL",
  "RUNTIME_DISPATCH_SECRET",
  "RUNTIME_DISPATCH_URL",
  "SCREEN_PROXY_SECRET",
  "WORKER_DATABASE_URL",
]);

export function optionalContainerEnv(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("CONTAINER_ENV_JSON must be a JSON object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (BLOCKED_ENV_KEYS.has(key)) continue;
    if (typeof entry !== "string") {
      throw new Error(`CONTAINER_ENV_JSON.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

const SANDBOX_PROVIDERS = new Set([
  "none",
  "docker",
  "cloudflare",
  "e2b",
  "daytona",
  "createos",
  "box",
  "e2b-emulator",
  "daytona-emulator",
  "box-emulator",
  "desktop",
  "fake",
]);

/** Default cloudflare; CONTAINER_ENV_JSON may select a supported remote provider (e.g. docker). */
export function resolveCloudflareSandboxProvider(
  optional: Record<string, string>,
): string {
  const requested = optional.SANDBOX_PROVIDER?.trim();
  if (requested && SANDBOX_PROVIDERS.has(requested)) return requested;
  return "cloudflare";
}

export function apiContainerEnv(env: CloudflareEnv): Record<string, string> {
  const optional = optionalContainerEnv(env.CONTAINER_ENV_JSON);
  return {
    ...optional,
    AGENT_RUNTIME: "pi",
    API_HOST: "0.0.0.0",
    API_PORT: "3100",
    API_URL: env.API_URL,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.WEB_ORIGIN,
    CLOUDFLARE_COMPUTER_SECRET: env.COMPUTER_GATEWAY_SECRET,
    CLOUDFLARE_COMPUTER_URL: env.API_URL,
    DATABASE_URL: env.DATABASE_URL,
    DATA_DIR: "/tmp/rakazo",
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    OBJECT_STORE_GATEWAY_SECRET: env.OBJECT_STORE_GATEWAY_SECRET,
    OBJECT_STORE_GATEWAY_URL: env.API_URL,
    REALTIME_DATABASE_URL: env.REALTIME_DATABASE_URL ?? env.DATABASE_URL,
    REALTIME_FANOUT_SECRET: env.REALTIME_FANOUT_SECRET,
    REALTIME_FANOUT_URL: env.API_URL,
    SCREEN_PROXY_SECRET: env.SCREEN_PROXY_SECRET,
    SANDBOX_PROVIDER: resolveCloudflareSandboxProvider(optional),
    WEB_ORIGIN: env.WEB_ORIGIN,
  };
}

export function schedulerContainerEnv(env: CloudflareEnv): Record<string, string> {
  const optional = optionalContainerEnv(env.CONTAINER_ENV_JSON);
  return {
    ...optional,
    AGENT_RUNTIME: "pi",
    DATABASE_URL: env.WORKER_DATABASE_URL,
    DATA_DIR: "/tmp/rakazo",
    CLOUDFLARE_COMPUTER_SECRET: env.COMPUTER_GATEWAY_SECRET,
    CLOUDFLARE_COMPUTER_URL: env.API_URL,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    HEALTH_HOST: "0.0.0.0",
    HEALTH_PORT: "3200",
    OBJECT_STORE_GATEWAY_SECRET: env.OBJECT_STORE_GATEWAY_SECRET,
    OBJECT_STORE_GATEWAY_URL: env.API_URL,
    RAKAZO_RUNTIME_MODE: "scheduler",
    REALTIME_DATABASE_URL: env.REALTIME_DATABASE_URL ?? env.WORKER_DATABASE_URL,
    REALTIME_FANOUT_SECRET: env.REALTIME_FANOUT_SECRET,
    REALTIME_FANOUT_URL: env.API_URL,
    SCREEN_PROXY_SECRET: env.SCREEN_PROXY_SECRET,
    SANDBOX_PROVIDER: resolveCloudflareSandboxProvider(optional),
    RUNTIME_DISPATCH_SECRET: env.RUNTIME_DISPATCH_SECRET,
    RUNTIME_DISPATCH_URL: new URL("/__runtime/dispatch", env.API_URL).toString(),
  };
}

export function botRuntimeContainerEnv(env: CloudflareEnv, botId: string): Record<string, string> {
  const optional = optionalContainerEnv(env.CONTAINER_ENV_JSON);
  return {
    ...optional,
    AGENT_RUNTIME: "pi",
    BOT_ID: botId,
    CLOUDFLARE_COMPUTER_SECRET: env.COMPUTER_GATEWAY_SECRET,
    CLOUDFLARE_COMPUTER_URL: env.API_URL,
    DATABASE_URL: env.DATABASE_URL,
    DATA_DIR: "/tmp/rakazo",
    DB_POOL_MAX: "1",
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    GRAPHILE_WORKER_CONCURRENCY: "1",
    HEALTH_HOST: "0.0.0.0",
    HEALTH_PORT: "3300",
    OBJECT_STORE_GATEWAY_SECRET: env.OBJECT_STORE_GATEWAY_SECRET,
    OBJECT_STORE_GATEWAY_URL: env.API_URL,
    RAKAZO_RUNTIME_MODE: "bot",
    REALTIME_DATABASE_URL: env.REALTIME_DATABASE_URL ?? env.DATABASE_URL,
    REALTIME_FANOUT_SECRET: env.REALTIME_FANOUT_SECRET,
    REALTIME_FANOUT_URL: env.API_URL,
    RUNTIME_CALLBACK_URL: new URL("/__runtime/finished", env.API_URL).toString(),
    RUNTIME_DISPATCH_SECRET: env.RUNTIME_DISPATCH_SECRET,
    SCREEN_PROXY_SECRET: env.SCREEN_PROXY_SECRET,
    SANDBOX_PROVIDER: resolveCloudflareSandboxProvider(optional),
  };
}
