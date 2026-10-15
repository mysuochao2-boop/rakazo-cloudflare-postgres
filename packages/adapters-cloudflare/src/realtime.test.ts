import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { CloudflareRealtimeFanout, realtimeFanoutFromEnv } from "./realtime.js";

describe("CloudflareRealtimeFanout", () => {
  it("publishes authenticated topic envelopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const fanout = new CloudflareRealtimeFanout("https://api.example.com", "secret", fetchImpl);
    await fanout.publish("thread:1", "payload");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/__realtime/publish");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init?.body))).toEqual({ topic: "thread:1", payload: "payload" });
  });

  it("requires URL and secret together", () => {
    expect(() => realtimeFanoutFromEnv({ REALTIME_FANOUT_URL: "https://api.example.com" })).toThrow(
      "must be configured together",
    );
  });

  it("subscribes, unsubscribes, receives messages, and restores topics after reconnect", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket server");
    const connections: WebSocket[] = [];
    const commands: Array<{ type: string; topic: string }> = [];
    server.on("connection", (socket) => {
      connections.push(socket);
      socket.on("message", (data) => commands.push(JSON.parse(data.toString())));
    });

    const fanout = new CloudflareRealtimeFanout(
      `http://127.0.0.1:${address.port}`,
      "secret",
      fetch,
      10,
    );
    const received: string[] = [];
    try {
      const unsubscribe = await fanout.subscribe("thread:1", (payload) => received.push(payload));
      await vi.waitFor(() =>
        expect(commands).toContainEqual({ type: "subscribe", topic: "thread:1" }),
      );
      connections[0]?.send(JSON.stringify({ topic: "thread:1", payload: "first" }));
      await vi.waitFor(() => expect(received).toEqual(["first"]));

      connections[0]?.close(1012, "restart");
      await vi.waitFor(() => expect(connections.length).toBe(2));
      await vi.waitFor(() =>
        expect(
          commands.filter(
            (command) => command.type === "subscribe" && command.topic === "thread:1",
          ),
        ).toHaveLength(2),
      );

      await unsubscribe();
      await vi.waitFor(() =>
        expect(commands).toContainEqual({ type: "unsubscribe", topic: "thread:1" }),
      );
    } finally {
      await fanout.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
