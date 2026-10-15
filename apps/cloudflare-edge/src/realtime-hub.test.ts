import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "./realtime-hub.js";

function hub() {
  const ctx = {} as DurableObjectState;
  return new RealtimeHub(ctx, {} as never);
}

function socket(initial: string[] = []) {
  let attachment = { topics: initial };
  return {
    close: vi.fn(),
    deserializeAttachment: vi.fn(() => attachment),
    serializeAttachment: vi.fn((next: { topics: string[] }) => {
      attachment = next;
    }),
    topics: () => attachment.topics,
  };
}

describe("RealtimeHub subscriptions", () => {
  it("persists subscribe and unsubscribe state in the socket attachment", () => {
    const target = socket();
    hub().webSocketMessage(
      target as unknown as WebSocket,
      '{"type":"subscribe","topic":"thread:1"}',
    );
    expect(target.topics()).toEqual(["thread:1"]);

    hub().webSocketMessage(
      target as unknown as WebSocket,
      '{"type":"unsubscribe","topic":"thread:1"}',
    );
    expect(target.topics()).toEqual([]);
    expect(target.serializeAttachment).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized commands and subscription sets", () => {
    const tooLarge = socket();
    hub().webSocketMessage(tooLarge as unknown as WebSocket, "x".repeat(2_049));
    expect(tooLarge.close).toHaveBeenCalledWith(1009, "Invalid subscription message");

    const full = socket(Array.from({ length: 256 }, (_, index) => `topic:${index}`));
    hub().webSocketMessage(full as unknown as WebSocket, '{"type":"subscribe","topic":"extra"}');
    expect(full.close).toHaveBeenCalledWith(1008, "Too many subscriptions");
  });

  it("rejects oversized publication payloads", async () => {
    const response = await hub().fetch(
      new Request("https://hub.internal/publish", {
        method: "POST",
        body: JSON.stringify({ topic: "thread:1", payload: "x".repeat(129 * 1024) }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("does not echo reserved peer close codes", () => {
    const target = socket();
    hub().webSocketClose(target as unknown as WebSocket, 1006, "Peer disconnected");
    expect(target.close).toHaveBeenCalledWith(1001, "Peer disconnected");
  });
});
