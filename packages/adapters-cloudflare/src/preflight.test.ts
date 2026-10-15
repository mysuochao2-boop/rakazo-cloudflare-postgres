import { describe, expect, it } from "vitest";
import { cloudflarePreflight } from "./preflight.js";

function validEnv(): NodeJS.ProcessEnv {
  return {
    API_URL: "https://api.production.invalid",
    WEB_ORIGIN: "https://app.production.invalid",
    DATABASE_URL: "postgresql://user:password@pool.production.invalid/rakazo?sslmode=verify-full",
    WORKER_DATABASE_URL:
      "postgresql://user:password@direct.production.invalid/rakazo?sslmode=verify-full",
    BETTER_AUTH_SECRET: "auth-secret",
    ENCRYPTION_KEY: "encryption-key",
    REALTIME_FANOUT_SECRET: "realtime-secret",
    RUNTIME_DISPATCH_SECRET: "runtime-secret",
    SCREEN_PROXY_SECRET: "screen-secret",
    CONTAINER_ENV_JSON: JSON.stringify({
      SANDBOX_PROVIDER: "e2b",
      E2B_API_KEY: "sandbox-key",
      OBJECT_STORE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      OBJECT_STORE_BUCKET: "rakazo",
      OBJECT_STORE_ACCESS_KEY_ID: "object-access-key",
      OBJECT_STORE_SECRET_ACCESS_KEY: "object-secret-key",
    }),
  };
}

describe("Cloudflare deployment preflight", () => {
  it("accepts the external PostgreSQL, R2, and remote sandbox topology", () => {
    expect(cloudflarePreflight(validEnv())).toEqual({ errors: [], warnings: [] });
  });

  it("rejects local sandbox and incomplete object storage", () => {
    const env = validEnv();
    env.CONTAINER_ENV_JSON = JSON.stringify({
      SANDBOX_PROVIDER: "docker",
      OBJECT_STORE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    });
    const result = cloudflarePreflight(env);
    expect(result.errors).toContain(
      "SANDBOX_PROVIDER must be cloudflare or a remote provider: e2b, daytona, createos, or box",
    );
    expect(result.errors.some((error) => error.includes("must be configured together"))).toBe(true);
  });

  it("accepts Cloudflare Computers with an independent gateway secret", () => {
    const env = validEnv();
    env.CONTAINER_ENV_JSON = JSON.stringify({
      SANDBOX_PROVIDER: "cloudflare",
      OBJECT_STORE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      OBJECT_STORE_BUCKET: "rakazo",
      OBJECT_STORE_ACCESS_KEY_ID: "object-access-key",
      OBJECT_STORE_SECRET_ACCESS_KEY: "object-secret-key",
    });
    env.COMPUTER_GATEWAY_SECRET = "computer-secret";
    expect(cloudflarePreflight(env)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects reused internal secrets and placeholder origins", () => {
    const env = validEnv();
    env.API_URL = "https://api.example.com";
    env.REALTIME_FANOUT_SECRET = env.RUNTIME_DISPATCH_SECRET;
    const result = cloudflarePreflight(env);
    expect(result.errors).toContain("API_URL still uses a placeholder host");
    expect(result.errors).toContain(
      "RUNTIME_DISPATCH_SECRET and REALTIME_FANOUT_SECRET must be independent values",
    );
  });
});
