import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxProvider } from "./cloudflare-sandbox.js";

const context = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe("CloudflareSandboxProvider", () => {
  it.each([
    [undefined, "/home/rakazo"],
    [".", "/home/rakazo"],
    ["bots/test-bot", "/home/rakazo/bots/test-bot"],
    ["/home/rakazo/bots/test-bot", "/home/rakazo/bots/test-bot"],
  ])("sends cwd %s using the supervisor's absolute-path contract", async (cwd, expected) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ stdout: "", stderr: "", code: 0 }),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = new CloudflareSandboxProvider("https://edge.example.test", "computer-secret");
    const events = [];
    for await (const event of provider.execute(
      { id: "computer-home", botId: "test-bot", kind: "cloudflare", providerRef: "computer-home" },
      { argv: ["mkdir", "-p", "shared", "bots/test-bot"], cwd },
      context,
    )) {
      events.push(event);
    }
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://edge.example.test/__computers/computers/computer-home/exec");
    expect(JSON.parse(String(init?.body))).toMatchObject({ cwd: expected });
    expect(events).toEqual([{ type: "exit", code: 0 }]);
  });

  it("uses the authenticated Computer gateway and preserves provider identity", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "computer-home", resumed: false, started: true }),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = new CloudflareSandboxProvider("https://edge.example.test/", "computer-secret");

    await expect(
      provider.provision({ botId: "computer-home", homePath: "/unused" }, context),
    ).resolves.toMatchObject({
      id: "computer-home",
      providerRef: "computer-home",
      kind: "cloudflare",
      fresh: true,
      started: true,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://edge.example.test/__computers/computers");
    expect(init?.headers).toMatchObject({ authorization: "Bearer computer-secret" });
  });
});
