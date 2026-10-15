import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "./env.js";
import { readJsonWithLimit } from "./request-body.js";

interface SocketAttachment {
  topics: string[];
}

interface RealtimeEnvelope {
  topic: string;
  payload: string;
}

export class RealtimeHub extends DurableObject<CloudflareEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.serializeAttachment({ topics: [] } satisfies SocketAttachment);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method !== "POST" || url.pathname !== "/publish") {
      return new Response("Not found", { status: 404 });
    }
    const body = await readJsonWithLimit(request, 132 * 1024);
    if (!body.ok) {
      return Response.json(
        { error: body.status === 413 ? "request_too_large" : "invalid_request" },
        { status: body.status },
      );
    }
    const envelope = realtimeEnvelope(body.value);
    if (!envelope) return Response.json({ error: "invalid_request" }, { status: 400 });
    const serialized = JSON.stringify(envelope);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.topics.includes(envelope.topic)) socket.send(serialized);
    }
    return new Response(null, { status: 204 });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 2_048) {
      socket.close(1009, "Invalid subscription message");
      return;
    }
    let command: unknown;
    try {
      command = JSON.parse(message);
    } catch {
      socket.close(1003, "Invalid subscription message");
      return;
    }
    if (!command || typeof command !== "object") return;
    const candidate = command as { type?: unknown; topic?: unknown };
    if (
      (candidate.type !== "subscribe" && candidate.type !== "unsubscribe") ||
      typeof candidate.topic !== "string" ||
      !candidate.topic ||
      candidate.topic.length > 512
    ) {
      return;
    }
    const attachment = (socket.deserializeAttachment() as SocketAttachment | null) ?? {
      topics: [],
    };
    const topics = new Set(attachment.topics);
    if (candidate.type === "subscribe") {
      if (topics.size >= 256) {
        socket.close(1008, "Too many subscriptions");
        return;
      }
      topics.add(candidate.topic);
    } else {
      topics.delete(candidate.topic);
    }
    socket.serializeAttachment({ topics: [...topics] } satisfies SocketAttachment);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(sendableCloseCode(code), reason);
  }
}

function sendableCloseCode(code: number): number {
  if (code >= 3_000 && code <= 4_999) return code;
  if (code >= 1_000 && code <= 1_014 && ![1_004, 1_005, 1_006].includes(code)) return code;
  return 1_001;
}

function realtimeEnvelope(value: unknown): RealtimeEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RealtimeEnvelope>;
  if (
    typeof candidate.topic !== "string" ||
    !candidate.topic ||
    candidate.topic.length > 512 ||
    typeof candidate.payload !== "string" ||
    new TextEncoder().encode(candidate.payload).byteLength > 128 * 1024
  ) {
    return null;
  }
  return { topic: candidate.topic, payload: candidate.payload };
}
