import { describe, expect, it } from "vitest";
import { isLongLivedRequest } from "./container.js";

function req(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://bot.example.com${path}`, { headers });
}

describe("isLongLivedRequest", () => {
  it("keeps the /novnc websocket tunnel off the header deadline", () => {
    expect(isLongLivedRequest(req("/novnc/session/abc"))).toBe(true);
    expect(
      isLongLivedRequest(req("/rpc/threads/subscribe", { upgrade: "websocket" })),
    ).toBe(true);
  });

  it("keeps oRPC event iterators off the header deadline", () => {
    expect(isLongLivedRequest(req("/rpc/threads/subscribe"))).toBe(true);
    expect(isLongLivedRequest(req("/rpc/logs/subscribe"))).toBe(true);
    expect(
      isLongLivedRequest(req("/rpc/spaces", { accept: "text/event-stream" })),
    ).toBe(true);
  });

  it("bounds ordinary API and RPC calls", () => {
    expect(isLongLivedRequest(req("/api/auth/get-session"))).toBe(false);
    expect(isLongLivedRequest(req("/rpc/threads/get"))).toBe(false);
    expect(isLongLivedRequest(req("/ready"))).toBe(false);
  });
});
