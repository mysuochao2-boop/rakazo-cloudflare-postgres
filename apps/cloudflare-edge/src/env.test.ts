import { describe, expect, it } from "vitest";
import type { CloudflareEnv } from "./env.js";
import {
  apiContainerEnv,
  botRuntimeContainerEnv,
  optionalContainerEnv,
  schedulerContainerEnv,
} from "./env.js";

function testEnv(): CloudflareEnv {
  return {
    ASSETS: {} as Fetcher,
    API_CONTAINERS: {} as DurableObjectNamespace,
    BOT_RUNTIME_CONTAINERS: {} as DurableObjectNamespace,
    COMPUTER_CONTAINERS: {} as DurableObjectNamespace,
    REALTIME_HUB: {} as DurableObjectNamespace,
    OBJECT_STORE: {} as R2Bucket,
    SCHEDULER_CONTAINERS: {} as DurableObjectNamespace,
    DATABASE_URL: "postgres://database.example/rakazo",
    WORKER_DATABASE_URL: "postgres://worker-database.example/rakazo",
    BETTER_AUTH_SECRET: "auth-secret",
    ENCRYPTION_KEY: "encryption-key",
    SCREEN_PROXY_SECRET: "screen-secret",
    RUNTIME_DISPATCH_SECRET: "runtime-secret",
    REALTIME_FANOUT_SECRET: "realtime-secret",
    OBJECT_STORE_GATEWAY_SECRET: "object-gateway-secret",
    COMPUTER_GATEWAY_SECRET: "computer-gateway-secret",
    API_CONTAINER_REPLICAS: "2",
    SCHEDULER_CONTAINER_REPLICAS: "2",
    API_URL: "https://api.example.com",
    WEB_ORIGIN: "https://app.example.com",
  };
}

describe("container environment", () => {
  it("keeps the production model runtime out of optional overrides", () => {
    expect(optionalContainerEnv('{"AGENT_RUNTIME":"scripted","SANDBOX_PROVIDER":"none"}')).toEqual({
      SANDBOX_PROVIDER: "none",
    });
  });

  it("uses the Pi model runtime in every Cloudflare container role", () => {
    const env = testEnv();
    env.CONTAINER_ENV_JSON = '{"AGENT_RUNTIME":"scripted"}';

    expect(apiContainerEnv(env).AGENT_RUNTIME).toBe("pi");
    expect(schedulerContainerEnv(env).AGENT_RUNTIME).toBe("pi");
    expect(botRuntimeContainerEnv(env, "bot-1").AGENT_RUNTIME).toBe("pi");
  });

  it("does not let the JSON bundle replace required deployment settings", () => {
    const env = testEnv();
    env.CONTAINER_ENV_JSON = JSON.stringify({
      DATABASE_URL: "postgres://attacker.invalid/rakazo",
      API_PORT: "9999",
      REALTIME_FANOUT_SECRET: "attacker-realtime-secret",
      RUNTIME_DISPATCH_SECRET: "attacker-runtime-secret",
    });
    expect(apiContainerEnv(env)).toMatchObject({
      DATABASE_URL: "postgres://database.example/rakazo",
      API_PORT: "3100",
      REALTIME_FANOUT_SECRET: "realtime-secret",
    });
  });

  it("rejects non-string values", () => {
    expect(() => optionalContainerEnv('{"GRAPHILE_WORKER_CONCURRENCY":4}')).toThrow(
      "CONTAINER_ENV_JSON.GRAPHILE_WORKER_CONCURRENCY must be a string",
    );
  });
});
