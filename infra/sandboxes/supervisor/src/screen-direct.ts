import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  type DirectScreenCapability,
  openDirectScreenCapability,
} from "@rakazo/core/node/screen-direct";

/**
 * RAKAZO_SCREEN_DIRECT supervisor side: serve `/direct/<policy>/<exp>.<token>/...`
 * (noVNC static files and the websocket) from the computer's loopback noVNC port, so
 * the browser talks to this host directly instead of through the Cloudflare Worker.
 * The capability is sealed by the API with RAKAZO_SCREEN_DIRECT_SECRET; without that
 * secret every /direct request is refused.
 */
export interface ScreenDirectSupervisorConfig {
  secret: string;
  /** Allowed websocket `Origin` values (the noVNC page origin, i.e. this host). */
  allowedOrigins: Set<string>;
  /** CSP frame-ancestors source list for the embed page. */
  frameAncestors: string;
  upstreamHost: string;
}

export type DirectScreenPortCheck = (port: number) => Promise<boolean>;

const MIN_SECRET_LENGTH = 32;
const STATIC_TIMEOUT_MS = 15_000;
const UPGRADE_CONNECT_TIMEOUT_MS = 10_000;

function parseOrigin(value: string, name: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username
  ) {
    throw new Error(`${name} entries must be bare http(s) origins`);
  }
  return url.origin;
}

function originList(raw: string | undefined, name: string) {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseOrigin(entry, name));
}

/** Undefined (feature off) unless RAKAZO_SCREEN_DIRECT_SECRET is set. Invalid lists throw. */
export function screenDirectSupervisorConfig(
  env: Record<string, string | undefined> = process.env,
): ScreenDirectSupervisorConfig | undefined {
  const secret = env.RAKAZO_SCREEN_DIRECT_SECRET?.trim() ?? "";
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`RAKAZO_SCREEN_DIRECT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const publicBase = env.PUBLIC_SCREEN_BASE ?? env.SANDBOX_PUBLIC_SCREEN_BASE;
  const allowed = originList(
    env.RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS,
    "RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS",
  );
  if (!allowed.length && publicBase?.trim()) {
    allowed.push(parseOrigin(publicBase.trim(), "PUBLIC_SCREEN_BASE"));
  }
  if (!allowed.length) {
    throw new Error(
      "RAKAZO_SCREEN_DIRECT_SECRET needs PUBLIC_SCREEN_BASE or RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS",
    );
  }
  const ancestors = originList(
    env.RAKAZO_SCREEN_DIRECT_FRAME_ANCESTORS,
    "RAKAZO_SCREEN_DIRECT_FRAME_ANCESTORS",
  );
  return {
    secret,
    allowedOrigins: new Set(allowed),
    frameAncestors: ["'self'", ...ancestors].join(" "),
    upstreamHost: env.SANDBOX_SCREEN_HOST ?? "127.0.0.1",
  };
}

export function isDirectScreenPath(pathname: string) {
  return pathname.startsWith("/direct/");
}

function securityHeaders(headers: Headers, config: ScreenDirectSupervisorConfig) {
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", `frame-ancestors ${config.frameAncestors}`);
  return headers;
}

function refused(status: number, config: ScreenDirectSupervisorConfig) {
  return new Response(null, { status, headers: securityHeaders(new Headers(), config) });
}

/** Static noVNC files (embed.html, app/*, core/*, vendor/*) for a valid capability. */
export async function handleDirectScreenRequest(
  request: Request,
  config: ScreenDirectSupervisorConfig | undefined,
  isScreenPort: DirectScreenPortCheck,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response> {
  if (!config) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return refused(405, config);
  const capability = openDirectScreenCapability(new URL(request.url).pathname, config.secret, now);
  if (!capability?.rest) return refused(403, config);
  if (capability.rest === "websockify") return refused(426, config);
  if (!(await isScreenPort(capability.port))) return refused(403, config);
  let upstream: Response;
  try {
    upstream = await fetchImpl(
      `http://${config.upstreamHost}:${capability.port}/${capability.rest}`,
      {
        method: request.method,
        redirect: "manual",
        signal: AbortSignal.timeout(STATIC_TIMEOUT_MS),
      },
    );
  } catch {
    return refused(502, config);
  }
  if (upstream.status >= 300 && upstream.status < 400) return refused(502, config);
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "last-modified", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: securityHeaders(headers, config),
  });
}

function reject(socket: Duplex, status: string) {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
  socket.destroy();
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface DirectUpgradeDecision {
  capability: DirectScreenCapability;
  key: string;
  version: string;
  protocol?: string;
}

/** Pure checks for a websocket upgrade: capability, Origin and handshake headers. */
export function directScreenUpgradeDecision(
  request: IncomingMessage,
  config: ScreenDirectSupervisorConfig,
  now = Date.now(),
): DirectUpgradeDecision | string {
  const pathname = new URL(request.url ?? "/", "http://direct.invalid").pathname;
  const capability = openDirectScreenCapability(pathname, config.secret, now);
  if (capability?.rest !== "websockify") return "403 Forbidden";
  const origin = header(request, "origin");
  if (!origin || !config.allowedOrigins.has(origin)) return "403 Forbidden";
  if (header(request, "upgrade")?.toLowerCase() !== "websocket") return "400 Bad Request";
  const key = header(request, "sec-websocket-key") ?? "";
  const version = header(request, "sec-websocket-version") ?? "";
  const protocol = header(request, "sec-websocket-protocol");
  if (!/^[A-Za-z0-9+/=]{16,64}$/.test(key) || !/^\d{1,2}$/.test(version)) {
    return "400 Bad Request";
  }
  if (protocol !== undefined && !/^[A-Za-z0-9 ,._-]{1,128}$/.test(protocol)) {
    return "400 Bad Request";
  }
  return { capability, key, version, ...(protocol ? { protocol } : {}) };
}

/**
 * Websocket upgrade for `/direct/.../websockify`. Pipes raw bytes to the computer's
 * websockify with the provider token from the seal, and closes the tunnel when the
 * capability expires so a leaked or revoked URL cannot hold a stream open.
 */
export async function handleDirectScreenUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: ScreenDirectSupervisorConfig | undefined,
  isScreenPort: DirectScreenPortCheck,
  now = Date.now(),
) {
  if (!config) return reject(socket, "404 Not Found");
  const decision = directScreenUpgradeDecision(request, config, now);
  if (typeof decision === "string") return reject(socket, decision);
  const { capability } = decision;
  if (!(await isScreenPort(capability.port).catch(() => false))) {
    return reject(socket, "403 Forbidden");
  }
  const upstream: Socket = connect({ host: config.upstreamHost, port: capability.port });
  upstream.setNoDelay(true);
  const connectTimer = setTimeout(() => upstream.destroy(), UPGRADE_CONNECT_TIMEOUT_MS);
  const expiry = setTimeout(
    () => {
      upstream.destroy();
      socket.destroy();
    },
    Math.max(0, capability.expiresAt - Date.now()),
  );
  expiry.unref();
  const close = () => {
    clearTimeout(connectTimer);
    clearTimeout(expiry);
    upstream.destroy();
    socket.destroy();
  };
  upstream.once("error", close);
  upstream.once("close", close);
  socket.once("error", close);
  socket.once("close", close);
  upstream.once("connect", () => {
    clearTimeout(connectTimer);
    upstream.write(
      [
        `GET ${capability.socket} HTTP/1.1`,
        `Host: ${config.upstreamHost}:${capability.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${decision.key}`,
        `Sec-WebSocket-Version: ${decision.version}`,
        ...(decision.protocol ? [`Sec-WebSocket-Protocol: ${decision.protocol}`] : []),
        "",
        "",
      ].join("\r\n"),
    );
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

/**
 * Loopback ports currently published by managed computer containers. Cached briefly;
 * a miss refreshes once (after `missRefreshMs`) so a just-started computer works.
 */
export function cachedScreenPortCheck(
  listPorts: () => Promise<Iterable<number>>,
  ttlMs = 5_000,
  missRefreshMs = 1_000,
): DirectScreenPortCheck {
  let cache: { at: number; ports: Set<number> } | undefined;
  let pending: Promise<Set<number>> | undefined;
  const refresh = async () => {
    pending ??= listPorts()
      .then((ports) => new Set(ports))
      .finally(() => {
        pending = undefined;
      });
    const ports = await pending;
    cache = { at: Date.now(), ports };
    return ports;
  };
  return async (port) => {
    if (!cache || Date.now() - cache.at > ttlMs) return (await refresh()).has(port);
    if (cache.ports.has(port)) return true;
    if (Date.now() - cache.at < missRefreshMs) return false;
    return (await refresh()).has(port);
  };
}
