import type { CloudflareEnv } from "./env.js";
import { bearerAuthorized } from "./internal-auth.js";
import { readJsonWithLimit } from "./request-body.js";

export async function objectGatewayRequest(
  request: Request,
  env: CloudflareEnv,
): Promise<Response> {
  if (!bearerAuthorized(request, env.OBJECT_STORE_GATEWAY_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  if (url.pathname === "/__objects/list" && request.method === "POST") {
    const body = await readJsonWithLimit(request, 8 * 1024);
    if (!body.ok) return Response.json({ error: "invalid_request" }, { status: body.status });
    const input = listInput(body.value);
    if (!input) return Response.json({ error: "invalid_request" }, { status: 400 });
    const page = await env.OBJECT_STORE.list(input);
    return Response.json({
      keys: page.objects.map((object) => object.key),
      ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
    });
  }
  if (url.pathname !== "/__objects/object") return new Response("Not found", { status: 404 });
  const key = url.searchParams.get("key");
  if (!key || key.length > 1_024 || key.includes("\0")) {
    return Response.json({ error: "invalid_key" }, { status: 400 });
  }
  if (request.method === "GET") {
    const object = await env.OBJECT_STORE.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  }
  if (request.method === "PUT") {
    await env.OBJECT_STORE.put(key, request.body ?? new Uint8Array(), {
      httpMetadata: { contentType: request.headers.get("content-type") ?? undefined },
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === "DELETE") {
    await env.OBJECT_STORE.delete(key);
    return new Response(null, { status: 204 });
  }
  return new Response("Method not allowed", { status: 405 });
}

function listInput(value: unknown): R2ListOptions | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { prefix?: unknown; cursor?: unknown };
  if (typeof candidate.prefix !== "string" || candidate.prefix.length > 1_024) return null;
  if (
    candidate.cursor !== undefined &&
    (typeof candidate.cursor !== "string" || candidate.cursor.length > 2_048)
  ) {
    return null;
  }
  return { prefix: candidate.prefix, limit: 1_000, cursor: candidate.cursor as string | undefined };
}
