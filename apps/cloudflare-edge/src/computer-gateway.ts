import { safeScreenProxyResponseHeaders } from "@rakazo/core/screen-proxy-headers";
import type { CloudflareEnv } from "./env.js";
import { bearerAuthorized } from "./internal-auth.js";
import { readBodyWithLimit } from "./request-body.js";

const COMPUTER_GENERATION = "v9";
const MAX_COMPUTER_REQUEST_BYTES = 22 * 1024 * 1024;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

function computerStub(env: CloudflareEnv, id: string) {
  return env.COMPUTER_CONTAINERS.getByName(`${COMPUTER_GENERATION}:${id}`);
}

export async function computerGatewayRequest(
  request: Request,
  env: CloudflareEnv,
): Promise<Response> {
  if (!bearerAuthorized(request, env.COMPUTER_GATEWAY_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const relative = url.pathname.slice("/__computers".length);
  let computerId: string | undefined;
  if (relative === "/computers" && request.method === "POST") {
    const bytes = await readBodyWithLimit(request, 8 * 1024);
    if (!bytes.ok) return Response.json({ error: "invalid_request" }, { status: bytes.status });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes.bytes));
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    computerId = (body as { botId?: unknown })?.botId as string | undefined;
    if (!validId(computerId)) return Response.json({ error: "invalid_request" }, { status: 400 });
    request = new Request(request, { body: new Blob([bytes.bytes as BlobPart]) });
  } else {
    const match = relative.match(/^\/computers\/([^/]+)(?:\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    try {
      computerId = decodeURIComponent(match[1]!);
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!validId(computerId)) return Response.json({ error: "invalid_request" }, { status: 400 });
    if (!["GET", "HEAD", "DELETE"].includes(request.method)) {
      const bytes = await readBodyWithLimit(request, MAX_COMPUTER_REQUEST_BYTES);
      if (!bytes.ok) return Response.json({ error: "invalid_request" }, { status: bytes.status });
      request = new Request(request, { body: new Blob([bytes.bytes as BlobPart]) });
    }
  }
  url.pathname = relative;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set("x-rakazo-computer-id", computerId);
  return computerStub(env, computerId).fetch(
    new Request(url, { method: request.method, headers, body: request.body }),
  );
}

export async function computerScreenRequest(
  request: Request,
  env: CloudflareEnv,
  apiContainerName: string,
): Promise<Response> {
  const targetResponse = await env.API_CONTAINERS.getByName(apiContainerName).fetch(
    "https://api.internal/api/internal/screen-target",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SCREEN_PROXY_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
      }),
    },
  );
  if (!targetResponse.ok) return new Response("Forbidden", { status: 403 });
  const target = (await targetResponse.json()) as {
    hostname?: unknown;
    port?: unknown;
    path?: unknown;
  };
  if (
    target.hostname !== "computer.internal" ||
    !Number.isInteger(target.port) ||
    Number(target.port) < 6080 ||
    Number(target.port) >= 6080 + 16 ||
    typeof target.path !== "string"
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  const path = target.path as string;
  const targetUrl = new URL(path, "http://computer.internal");
  const match = targetUrl.pathname.match(/^\/([^/]+)(\/.*)$/);
  if (!match) return new Response("Forbidden", { status: 403 });
  let computerId: string;
  try {
    computerId = decodeURIComponent(match[1]!);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  if (!validId(computerId)) return new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  // Older API images mint a root-relative socket path for the nested embed.
  // The shipped embed resolves relative to its directory, so preserve the
  // validated capability URL but repair its public (unsealed) viewer option.
  if (
    match[2] === "/embed.html" &&
    url.searchParams.has("path") &&
    url.searchParams.get("path") !== "websockify"
  ) {
    url.searchParams.set("path", "websockify");
    return new Response(null, {
      status: 307,
      headers: { location: url.toString(), "cache-control": "no-store" },
    });
  }
  url.pathname = `/__port/${target.port}${match[2]}`;
  url.search = targetUrl.search;
  const headers = new Headers(request.headers);
  for (const name of ["authorization", "cookie", "host", "proxy-authorization"]) {
    headers.delete(name);
  }
  headers.set("x-rakazo-computer-id", computerId);
  const response = await computerStub(env, computerId).fetch(
    new Request(url, { method: request.method, headers, body: request.body }),
  );
  const safe = safeScreenProxyResponseHeaders(Object.fromEntries(response.headers));
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(safe)) {
    for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      responseHeaders.append(name, part);
    }
  }
  // The capability is checked on every request, including module imports from
  // the viewer's opaque iframe origin. Never reuse an old unsanitized response.
  // Cloudflare Web Analytics must not inject its beacon into the opaque noVNC iframe:
  // the beacon posts to /cdn-cgi/rum with Origin: null and creates a misleading CORS error.
  responseHeaders.set("cache-control", "no-store, no-transform");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}
