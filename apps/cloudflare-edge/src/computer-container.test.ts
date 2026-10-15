import { describe, expect, it, vi } from "vitest";
import { ComputerContainer, containerStartEnv } from "./computer-container.js";
import type { CloudflareEnv } from "./env.js";

function commandFixture() {
  const stored = new Map<string, unknown>([["controlToken", "control-token"]]);
  const exec = vi.fn(async (_body: unknown) => Response.json({ stdout: "", stderr: "", code: 0 }));
  const controlFetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/v1/exec")) {
      return exec(JSON.parse(String(init?.body)));
    }
    return Response.json({ completed: 0 });
  });
  const container = {
    running: true,
    images: { computer: "test-image" },
    start: vi.fn(() => {
      container.running = true;
    }),
    monitor: () => new Promise(() => {}),
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({ fetch: controlFetch }),
  };
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => stored.set(key, value),
      delete: async (key: string) => stored.delete(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...stored].filter(([key]) => key.startsWith(prefix))),
    },
    container,
    waitUntil: () => {},
  } as unknown as DurableObjectState;
  const computer = new ComputerContainer(ctx, {} as CloudflareEnv);
  return {
    exec,
    stored,
    container,
    provision: () =>
      computer.fetch(
        new Request("https://edge.example.test/computers", {
          method: "POST",
          headers: { "x-rakazo-computer-id": "test-home" },
        }),
      ),
    files: () =>
      computer.fetch(
        new Request("https://edge.example.test/computers/test-home/files", {
          headers: { "x-rakazo-computer-id": "test-home" },
        }),
      ),
    screen: (
      interactive: boolean,
      options: { controlToken?: string; revokeControl?: boolean } = {},
    ) =>
      computer.fetch(
        new Request("https://edge.example.test/computers/test-home/screen-mode", {
          method: "POST",
          headers: { "x-rakazo-computer-id": "test-home", "content-type": "application/json" },
          body: JSON.stringify({
            interactive,
            controlToken: interactive ? (options.controlToken ?? "lease-1") : options.controlToken,
            revokeControl: options.revokeControl,
          }),
        }),
      ),
    release: () =>
      computer.fetch(
        new Request("https://edge.example.test/computers/test-home/screen", {
          method: "DELETE",
          headers: { "x-rakazo-computer-id": "test-home" },
        }),
      ),
    request: (cwd?: string) =>
      computer.fetch(
        new Request("https://edge.example.test/computers/test-home/exec", {
          method: "POST",
          headers: {
            "x-rakazo-computer-id": "test-home",
            "content-type": "application/json",
          },
          // DockerSandboxProvider.execute serializes the cwd as an absolute
          // container path, including when the caller leaves it undefined.
          body: JSON.stringify({ argv: ["mkdir", "-p", "shared", "bots/test-bot"], cwd }),
        }),
      ),
  };
}

describe("Cloudflare Computer commands", () => {
  it("sets the PATH before the container exec launcher resolves commands", () => {
    expect(containerStartEnv("control-token")).toEqual({
      HOME: "/home/rakazo",
      PATH: "/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      RAKAZO_COMPUTER_CONTROL_TOKEN: "control-token",
    });
  });

  it.each([
    [undefined, "/home/rakazo"],
    ["/home/rakazo", "/home/rakazo"],
    ["/home/rakazo/", "/home/rakazo"],
    ["/home/rakazo/bots/test-bot", "/home/rakazo/bots/test-bot"],
    ["bots/test-bot", "/home/rakazo/bots/test-bot"],
    [".", "/home/rakazo"],
    ["/", "/home/rakazo"],
  ])("forwards command cwd %s without duplicating the home prefix", async (cwd, expected) => {
    const fixture = commandFixture();
    const response = await fixture.request(cwd);
    expect(response.status).toBe(200);
    expect(fixture.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["mkdir", "-p", "shared", "bots/test-bot"],
        cwd: expected,
      }),
    );
  });

  it.each(["/etc", "/home/rakazo-other", "../outside", "/home/rakazo/../outside"])(
    "does not execute with an out-of-workspace cwd %s",
    async (cwd) => {
      const fixture = commandFixture();
      const response = await fixture.request(cwd);
      expect(response.ok).toBe(false);
      expect(fixture.exec).not.toHaveBeenCalled();
    },
  );

  it("releases only the target browser without killing the cleanup shell", async () => {
    const fixture = commandFixture();
    const profile = "/home/rakazo/.browser-profiles/chromium-bot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fixture.stored.set("screen:test-home", 0);
    fixture.stored.set("screen-profile:test-home", profile);
    fixture.stored.set("screen-mode:test-home", "view");
    const response = await fixture.release();
    expect(response.status).toBe(200);
    const { argv } = fixture.exec.mock.calls[0]![0] as { argv: string[] };
    const script = argv[2]!;
    const pattern = script.match(/pkill -f -- '([^']+)'/)![1]!;
    const browser = new RegExp(pattern.replace("[[:space:]]", "\\s"));
    expect(browser.test(`/usr/lib/chromium/chromium --user-data-dir=${profile}`)).toBe(true);
    expect(browser.test(`/usr/lib/chromium/chromium --user-data-dir=${profile}-other`)).toBe(false);
    expect(browser.test(`bash -c ${script}`)).toBe(false);
    expect(fixture.stored.has("screen:test-home")).toBe(false);
    expect(fixture.stored.has("screen-mode:test-home")).toBe(false);
  });

  it("replaces legacy noVNC transports even when their HTML still responds", async () => {
    const fixture = commandFixture();
    fixture.stored.set("screen:test-home", 0);
    fixture.stored.set("screen-profile:test-home", "/home/rakazo/.browser-profiles/test");
    fixture.stored.set("screen-mode:test-home", "view");
    expect((await fixture.screen(false)).status).toBe(200);
    expect(fixture.exec).toHaveBeenCalledOnce();
    const { argv } = fixture.exec.mock.calls[0]![0] as { argv: string[] };
    const script = argv[2]!;
    const pattern = script.match(/pkill -f '([^']+websockify[^']+)'/)![1]!;
    const transport = new RegExp(pattern.replace("[[:space:]]", "\\s"));
    expect(
      transport.test("/usr/bin/python3 /usr/bin/websockify --token-plugin=TokenFile 0.0.0.0:6080"),
    ).toBe(true);
    expect(
      transport.test("/usr/bin/websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900"),
    ).toBe(true);
    expect(transport.test("websockify --web=/usr/share/novnc 0.0.0.0:60801")).toBe(false);
    expect(transport.test(`bash -c ${script}`)).toBe(false);
    expect(script).toContain('kill -0 "$vnc_pid" "$web_pid"');
    expect(fixture.stored.get("screen-setup-version:test-home")).toBe(2);
    expect((await fixture.screen(false)).status).toBe(200);
    expect(fixture.exec).toHaveBeenCalledOnce();
  });

  it("does not cache a failed screen setup", async () => {
    const fixture = commandFixture();
    fixture.stored.set("screen:test-home", 0);
    fixture.stored.set("screen-profile:test-home", "/home/rakazo/.browser-profiles/test");
    fixture.exec.mockResolvedValueOnce(Response.json({ stdout: "", stderr: "", code: 1 }));
    expect((await fixture.screen(false)).status).toBe(500);
    expect(fixture.stored.has("screen-mode:test-home")).toBe(false);
    expect(fixture.stored.has("screen-setup-version:test-home")).toBe(false);
    expect((await fixture.screen(false)).status).toBe(200);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });

  it("keeps control active when a view-only observer connects", async () => {
    const fixture = commandFixture();
    expect((await fixture.screen(true, { controlToken: "lease-current" })).status).toBe(200);
    expect(fixture.stored.get("screen-mode:test-home")).toBe("control");
    expect(fixture.stored.get("screen-control-token:test-home")).toBe("lease-current");
    expect(fixture.exec).toHaveBeenCalledOnce();

    const preview = await fixture.screen(false, { revokeControl: false });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      screenUrl: expect.stringContaining("view_only=true"),
    });
    expect(fixture.stored.get("screen-mode:test-home")).toBe("control");
    expect(fixture.stored.get("screen-control-token:test-home")).toBe("lease-current");
    expect(fixture.exec).toHaveBeenCalledOnce();
  });

  it("does not let an older lease revoke the current control transport", async () => {
    const fixture = commandFixture();
    await fixture.screen(true, { controlToken: "lease-current" });
    await fixture.screen(false, { controlToken: "lease-old" });
    expect(fixture.stored.get("screen-mode:test-home")).toBe("control");
    expect(fixture.stored.get("screen-control-token:test-home")).toBe("lease-current");
    expect(fixture.exec).toHaveBeenCalledOnce();

    await fixture.screen(false, { controlToken: "lease-current" });
    expect(fixture.stored.get("screen-mode:test-home")).toBe("view");
    expect(fixture.stored.has("screen-control-token:test-home")).toBe(false);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });

  it("does not replay a control request after that lease was revoked", async () => {
    const fixture = commandFixture();
    await fixture.screen(true, { controlToken: "lease-current" });
    await fixture.screen(false, { controlToken: "lease-current" });
    await fixture.screen(true, { controlToken: "lease-current" });
    expect(fixture.stored.get("screen-mode:test-home")).toBe("view");
    expect(fixture.stored.has("screen-control-token:test-home")).toBe(false);
    expect(fixture.stored.get("screen-revoked-control-token:test-home")).toBe("lease-current");
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });

  it("keeps the screen assignment for retry when cleanup fails", async () => {
    const fixture = commandFixture();
    fixture.stored.set("screen:test-home", 0);
    fixture.stored.set("screen-profile:test-home", "/home/rakazo/.browser-profiles/test");
    fixture.stored.set("screen-mode:test-home", "view");
    fixture.exec.mockResolvedValueOnce(Response.json({ stdout: "", stderr: "", code: -15 }));
    expect((await fixture.release()).status).toBe(500);
    expect(fixture.stored.get("screen:test-home")).toBe(0);
    expect(fixture.stored.get("screen-mode:test-home")).toBe("view");
  });

  it("does not silently start an empty computer for file or screen requests", async () => {
    const fixture = commandFixture();
    fixture.container.running = false;
    expect((await fixture.files()).status).toBe(404);
    expect((await fixture.screen(false)).status).toBe(404);
    expect(fixture.container.start).not.toHaveBeenCalled();
    expect(fixture.exec).not.toHaveBeenCalled();
  });

  it("invalidates stale transport flags on explicit restart without dropping assignments", async () => {
    const fixture = commandFixture();
    fixture.container.running = false;
    fixture.stored.set("screen:test-home", 0);
    fixture.stored.set("screen-mode:test-home", "control");
    fixture.stored.set("screen-setup-version:test-home", 2);
    const response = await fixture.provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed: false, started: true });
    expect(fixture.container.start).toHaveBeenCalledOnce();
    expect(fixture.stored.has("screen-setup-version:test-home")).toBe(false);
    expect(fixture.stored.get("screen:test-home")).toBe(0);
    expect(fixture.stored.get("screen-mode:test-home")).toBe("control");
  });
});
