import { describe, expect, it, vi } from "vitest";
import { CloudflareRunDispatcher, runDispatcherFromEnv } from "./run-dispatcher.js";

describe("CloudflareRunDispatcher", () => {
  it("authenticates and forwards the bot identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const dispatcher = new CloudflareRunDispatcher(
      "https://api.example.com/__runtime/dispatch",
      "secret",
      fetchImpl,
    );
    await dispatcher.dispatch({ runId: "run-1", botId: "bot-1" });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init?.body))).toEqual({ runId: "run-1", botId: "bot-1" });
  });

  it("requires URL and secret together", () => {
    expect(() => runDispatcherFromEnv({ RUNTIME_DISPATCH_URL: "https://api.example.com" })).toThrow(
      "must be configured together",
    );
  });
});
