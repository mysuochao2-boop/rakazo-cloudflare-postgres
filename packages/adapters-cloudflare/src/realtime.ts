import type { RealtimeFanout } from "@rakazo/adapter-kit";
import WebSocket from "ws";

interface RealtimeEnvelope {
  topic: string;
  payload: string;
}

export class CloudflareRealtimeFanout implements RealtimeFanout {
  private readonly listeners = new Map<string, Set<(payload: string) => void>>();
  private socket: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly reconnectDelayMs = 1_000,
  ) {}

  describe() {
    return {
      id: "cloudflare-durable-object-realtime",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { distributed: true, push: true },
    };
  }

  async publish(topic: string, payload: string): Promise<void> {
    const response = await this.fetchImpl(new URL("/__realtime/publish", this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ topic, payload }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Realtime publish failed (${response.status})`);
  }

  async subscribe(topic: string, onMessage: (payload: string) => void) {
    if (this.closed) throw new Error("Realtime fanout is closed");
    let topicListeners = this.listeners.get(topic);
    const first = !topicListeners;
    if (!topicListeners) {
      topicListeners = new Set();
      this.listeners.set(topic, topicListeners);
    }
    topicListeners.add(onMessage);
    const alreadyConnected = this.socket?.readyState === WebSocket.OPEN;
    const socket = await this.connect();
    if (first && alreadyConnected) this.send(socket, { type: "subscribe", topic });

    return async () => {
      const current = this.listeners.get(topic);
      current?.delete(onMessage);
      if (current?.size) return;
      this.listeners.delete(topic);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send(this.socket, { type: "unsubscribe", topic });
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "shutdown");
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const url = new URL("/__realtime/connect", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
      const failed = (error: Error) => {
        this.connecting = undefined;
        reject(error);
      };
      socket.once("error", failed);
      socket.once("open", () => {
        socket.off("error", failed);
        this.socket = socket;
        this.connecting = undefined;
        socket.on("message", (data) => this.receive(data.toString()));
        socket.once("close", () => {
          if (this.socket === socket) this.socket = undefined;
          if (!this.closed && this.listeners.size > 0) this.reconnect();
        });
        socket.on("error", () => undefined);
        for (const topic of this.listeners.keys()) this.send(socket, { type: "subscribe", topic });
        resolve(socket);
      });
    });
    return this.connecting;
  }

  private reconnect(): void {
    setTimeout(() => {
      if (this.closed || this.listeners.size === 0) return;
      void this.connect().catch(() => this.reconnect());
    }, this.reconnectDelayMs);
  }

  private receive(raw: string): void {
    let envelope: RealtimeEnvelope;
    try {
      envelope = JSON.parse(raw) as RealtimeEnvelope;
    } catch {
      return;
    }
    if (typeof envelope.topic !== "string" || typeof envelope.payload !== "string") return;
    for (const listener of this.listeners.get(envelope.topic) ?? []) listener(envelope.payload);
  }

  private send(socket: WebSocket, message: { type: string; topic: string }): void {
    socket.send(JSON.stringify(message));
  }
}

export function realtimeFanoutFromEnv(env: NodeJS.ProcessEnv): RealtimeFanout | undefined {
  const url = env.REALTIME_FANOUT_URL?.trim();
  const token = env.REALTIME_FANOUT_SECRET?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) {
    throw new Error("REALTIME_FANOUT_URL and REALTIME_FANOUT_SECRET must be configured together");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("REALTIME_FANOUT_URL must be an HTTPS URL without credentials");
  }
  return new CloudflareRealtimeFanout(parsed.toString(), token);
}
