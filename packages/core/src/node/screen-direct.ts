import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
  SCREEN_PROXY_TTL_MS,
  type ScreenCapabilityScope,
} from "./screen-capability.js";

/**
 * Direct screen capabilities let the browser load noVNC from the Docker supervisor's
 * public host (for example `https://computer.51proxy.org/direct/...`) instead of the
 * Cloudflare Worker relay. The API seals the provider screen URL with a secret shared
 * only with the supervisor; the supervisor opens it, checks expiry and Origin, and
 * proxies the static files and the websocket to the computer's loopback noVNC port.
 *
 * Unlike the Worker path, the supervisor cannot re-read control leases from the
 * database. Revocation instead relies on the provider tokens inside the seal: control
 * release stops the control x11vnc, and screen resets rotate the websockify tokens.
 * Open sockets are closed when the capability expires.
 */
export const SCREEN_DIRECT_PATH_PREFIX = "/direct/";
export const SCREEN_DIRECT_TTL_MS = SCREEN_PROXY_TTL_MS;
const DIRECT_PATH_PATTERN = /^\/direct\/(view|control)\/(\d+)\.([A-Za-z0-9_-]+)\/(.*)$/;
const SCREEN_PATH_PATTERN = /^\/screen\/([1-9][0-9]{3,4})\/embed\.html$/;
const MIN_SECRET_LENGTH = 32;

export interface ScreenDirectConfig {
  /** Shared with the supervisor as `RAKAZO_SCREEN_DIRECT_SECRET`. */
  secret: string;
  /** Public supervisor origin whose `/screen/<port>/embed.html` URLs go direct. */
  origin: string;
}

export interface DirectScreenCapability {
  policy: "view" | "control";
  expiresAt: number;
  port: number;
  /** Provider websocket path and query on the computer's noVNC port, e.g. `/websockify?token=...`. */
  socket: string;
  /** Path after the capability directory, e.g. `embed.html` or `websockify`. */
  rest: string;
  scope: ScreenCapabilityScope;
}

/**
 * API-side opt-in. `RAKAZO_SCREEN_DIRECT=1` needs `RAKAZO_SCREEN_DIRECT_SECRET` (32+ chars)
 * and an https `RAKAZO_SCREEN_DIRECT_ORIGIN`; anything else keeps the Worker relay.
 */
export function resolveScreenDirectConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = () => undefined,
): ScreenDirectConfig | undefined {
  const flag = env.RAKAZO_SCREEN_DIRECT?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return undefined;
  const secret = env.RAKAZO_SCREEN_DIRECT_SECRET?.trim() ?? "";
  const origin = parseDirectOrigin(env.RAKAZO_SCREEN_DIRECT_ORIGIN);
  if (secret.length < MIN_SECRET_LENGTH || !origin) {
    warn(
      "RAKAZO_SCREEN_DIRECT ignored: set RAKAZO_SCREEN_DIRECT_SECRET (32+ chars) and an https RAKAZO_SCREEN_DIRECT_ORIGIN",
    );
    return undefined;
  }
  return { secret, origin };
}

function parseDirectOrigin(value: string | undefined) {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** True when `url` is a supervisor noVNC embed on the configured direct origin. */
export function isDirectScreenUrl(url: string, config: ScreenDirectConfig) {
  try {
    const target = new URL(url);
    return target.origin === config.origin && SCREEN_PATH_PATTERN.test(target.pathname);
  } catch {
    return false;
  }
}

function directKey(secret: string) {
  // Domain-separated from the Worker capability key even if an operator reuses a secret.
  return createHash("sha256").update(`rakazo-screen-direct\0${secret}`).digest();
}

function directAad(policy: string, expiresAt: number) {
  return Buffer.from(`direct:${policy}:${expiresAt}`);
}

export function sealDirectScreenCapability(
  url: string,
  config: ScreenDirectConfig,
  scope: ScreenCapabilityScope,
  now = Date.now(),
) {
  const target = new URL(url);
  const port = Number(target.pathname.match(SCREEN_PATH_PATTERN)?.[1]);
  if (target.origin !== config.origin || !port) throw new Error("Not a direct screen URL");
  const socketUrl = new URL(target.searchParams.get("path") ?? "websockify", target);
  if (socketUrl.origin !== target.origin || socketUrl.pathname !== `/screen/${port}/websockify`) {
    throw new Error("Invalid direct screen socket");
  }
  const policy = target.searchParams.get("view_only") === "false" ? "control" : "view";
  const expiresAt = now + SCREEN_DIRECT_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", directKey(config.secret), iv, { authTagLength: 16 });
  cipher.setAAD(directAad(policy, expiresAt));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({ port, socket: `/websockify${socketUrl.search}`, scope }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  const result = new URL(
    `${SCREEN_DIRECT_PATH_PREFIX}${policy}/${expiresAt}.${token}/embed.html`,
    config.origin,
  );
  result.search = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    view_only: policy === "control" ? "false" : "true",
    path: "websockify",
  }).toString();
  return result.toString();
}

const directSeals = new Map<string, { sealed: string; expiresAt: number }>();

/** Drop cached direct seals (tests). */
export function resetDirectScreenCapabilityReuse() {
  directSeals.clear();
}

/**
 * Issue a direct capability, reusing a still-valid seal for the same upstream URL and
 * scope so a polling client does not reload a connected screen on every read.
 */
export function issueDirectScreenCapability(
  url: string,
  config: ScreenDirectConfig,
  scope: ScreenCapabilityScope,
  now = Date.now(),
) {
  const key = [
    createHash("sha256").update(config.secret).digest("base64url"),
    url,
    scope.botId,
    scope.computerId,
    String(scope.botGeneration),
    String(scope.computerGeneration),
    scope.controlLeaseId ?? "",
  ].join("\0");
  const cached = directSeals.get(key);
  if (cached && cached.expiresAt - now > REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS) {
    return cached.sealed;
  }
  for (const [cachedKey, entry] of directSeals) {
    if (entry.expiresAt <= now) directSeals.delete(cachedKey);
  }
  const sealed = sealDirectScreenCapability(url, config, scope, now);
  directSeals.set(key, { sealed, expiresAt: now + SCREEN_DIRECT_TTL_MS });
  return sealed;
}

/** Supervisor-side check of a `/direct/<policy>/<exp>.<token>/<rest>` request path. */
export function openDirectScreenCapability(
  pathname: string,
  secret: string,
  now = Date.now(),
): DirectScreenCapability | null {
  const match = pathname.match(DIRECT_PATH_PATTERN);
  if (!match) return null;
  const policy = match[1] as "view" | "control";
  const expiresAt = Number(match[2]);
  const rest = match[4] ?? "";
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  if (
    !/^[A-Za-z0-9._/-]*$/.test(rest) ||
    rest.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  try {
    const sealed = Buffer.from(match[3]!, "base64url");
    if (sealed.length < 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", directKey(secret), sealed.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(directAad(policy, expiresAt));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8"),
    );
    const scope = payload.scope as ScreenCapabilityScope;
    if (
      !Number.isInteger(payload.port) ||
      payload.port < 1024 ||
      payload.port > 65535 ||
      typeof payload.socket !== "string" ||
      !/^\/websockify(\?[A-Za-z0-9._~%=&+-]*)?$/.test(payload.socket) ||
      !scope ||
      typeof scope.botId !== "string" ||
      typeof scope.computerId !== "string"
    ) {
      return null;
    }
    return { policy, expiresAt, port: payload.port, socket: payload.socket, rest, scope };
  } catch {
    return null;
  }
}
