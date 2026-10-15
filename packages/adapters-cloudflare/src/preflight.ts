import { objectStoreFromEnv } from "./object-store.js";

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

const REMOTE_SANDBOX_KEYS: Record<string, string> = {
  box: "BOX_API_KEY",
  createos: "CREATEOS_SANDBOX_API_KEY",
  daytona: "DAYTONA_API_KEY",
  e2b: "E2B_API_KEY",
};

const REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "REALTIME_FANOUT_SECRET",
  "RUNTIME_DISPATCH_SECRET",
  "SCREEN_PROXY_SECRET",
] as const;

export function cloudflarePreflight(source: NodeJS.ProcessEnv): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const env = cloudflareDeploymentEnv(source, errors);

  validatePostgresUrl(env.DATABASE_URL, "DATABASE_URL", errors, warnings);
  validatePostgresUrl(env.WORKER_DATABASE_URL, "WORKER_DATABASE_URL", errors, warnings);
  validateHttpsUrl(env.API_URL, "API_URL", errors);
  validateHttpsUrl(env.WEB_ORIGIN, "WEB_ORIGIN", errors);

  for (const key of REQUIRED_SECRETS) {
    if (!env[key]?.trim()) errors.push(`${key} is required`);
  }
  if (
    env.RUNTIME_DISPATCH_SECRET?.trim() &&
    env.RUNTIME_DISPATCH_SECRET === env.REALTIME_FANOUT_SECRET
  ) {
    errors.push("RUNTIME_DISPATCH_SECRET and REALTIME_FANOUT_SECRET must be independent values");
  }

  const provider =
    env.SANDBOX_PROVIDER?.trim() ||
    (env.COMPUTER_GATEWAY_SECRET?.trim() ? "cloudflare" : undefined);
  const keyName = provider ? REMOTE_SANDBOX_KEYS[provider] : undefined;
  if (provider === "cloudflare") {
    if (!env.COMPUTER_GATEWAY_SECRET?.trim()) {
      errors.push("COMPUTER_GATEWAY_SECRET is required for SANDBOX_PROVIDER=cloudflare");
    } else if (
      REQUIRED_SECRETS.some((key) => env[key]?.trim() === env.COMPUTER_GATEWAY_SECRET?.trim())
    ) {
      errors.push("COMPUTER_GATEWAY_SECRET must be independent from other internal secrets");
    }
  } else if (!keyName) {
    errors.push(
      "SANDBOX_PROVIDER must be cloudflare or a remote provider: e2b, daytona, createos, or box",
    );
  } else if (!env[keyName]?.trim()) {
    errors.push(`${keyName} is required for SANDBOX_PROVIDER=${provider}`);
  }

  try {
    if (!objectStoreFromEnv(env)) errors.push("R2 object-store configuration is required");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid OBJECT_STORE_* configuration");
  }

  if (env.MCP_STDIO_ENABLED === "true") {
    warnings.push("MCP stdio is enabled; keep its executable allowlist minimal in Containers");
  }
  return { errors, warnings };
}

export function cloudflareDeploymentEnv(
  source: NodeJS.ProcessEnv,
  errors: string[] = [],
): NodeJS.ProcessEnv {
  const raw = source.CONTAINER_ENV_JSON?.trim();
  if (!raw) return { ...source };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    const optional: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        errors.push(`CONTAINER_ENV_JSON.${key} must be a string`);
      } else {
        optional[key] = value;
      }
    }
    return { ...optional, ...source };
  } catch {
    errors.push("CONTAINER_ENV_JSON must be a JSON object");
    return { ...source };
  }
}

function validateHttpsUrl(value: string | undefined, name: string, errors: string[]): void {
  if (!value?.trim()) {
    errors.push(`${name} is required`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    if (url.hostname.endsWith(".example.com") || url.hostname.endsWith(".example.test")) {
      errors.push(`${name} still uses a placeholder host`);
    }
  } catch {
    errors.push(`${name} must be an HTTPS URL without credentials`);
  }
}

function validatePostgresUrl(
  value: string | undefined,
  name: string,
  errors: string[],
  warnings: string[],
): void {
  if (!value?.trim()) {
    errors.push(`${name} is required`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
    if (!url.hostname || !url.pathname.slice(1)) throw new Error();
    const sslMode = url.searchParams.get("sslmode");
    if (!sslMode || sslMode === "disable" || sslMode === "allow" || sslMode === "prefer") {
      warnings.push(`${name} should explicitly require TLS with certificate verification`);
    }
  } catch {
    errors.push(`${name} must be a PostgreSQL connection URL`);
  }
}
