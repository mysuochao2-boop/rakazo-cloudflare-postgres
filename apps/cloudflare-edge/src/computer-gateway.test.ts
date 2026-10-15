import { describe, expect, it, vi } from "vitest";
import { computerScreenRequest } from "./computer-gateway.js";
import type { CloudflareEnv } from "./env.js";

describe("Cloudflare Computer screen gateway", () => {
  it.each(["text/html", "text/javascript", "application/javascript"])(
    "serves %s to the opaque iframe without relaxing its isolation",
    async (contentType) => {
      const computerFetch = vi.fn(
        async (_request: Request) =>
          new Response("asset", {
            headers: {
              "content-type": contentType,
              "content-security-policy": "frame-ancestors 'self'",
              "set-cookie": "session=fake",
              "clear-site-data": '"cookies"',
              "access-control-allow-origin": "https://upstream.example",
              "access-control-allow-credentials": "true",
            },
          }),
      );
      const env = {
        API_CONTAINERS: {
          getByName: () => ({
            fetch: async () =>
              Response.json({
                hostname: "computer.internal",
                port: 6080,
                path: "/computer-home/core/rfb.js",
              }),
          }),
        },
        COMPUTER_CONTAINERS: { getByName: () => ({ fetch: computerFetch }) },
        SCREEN_PROXY_SECRET: "screen-secret",
      } as unknown as CloudflareEnv;
      const response = await computerScreenRequest(
        new Request("https://app.example/novnc/session/view/capability/computer-home/core/rfb.js", {
          headers: { origin: "null", cookie: "session=fake", authorization: "Bearer fake" },
        }),
        env,
        "api-v1",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.has("access-control-allow-credentials")).toBe(false);
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts allow-pointer-lock",
      );
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
      expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.has("clear-site-data")).toBe(false);
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(computerFetch.mock.calls[0]![0].headers.has("cookie")).toBe(false);
      expect(computerFetch.mock.calls[0]![0].headers.has("authorization")).toBe(false);
    },
  );

  it.each(["view", "control"])(
    "repairs an already-issued nested %s embed URL without exposing its target",
    async (mode) => {
      const computerFetch = vi.fn(async () => new Response("desktop"));
      const getTarget = vi.fn(async () =>
        Response.json({
          hostname: "computer.internal",
          port: 6080,
          path: `/computer-home/embed.html?view_only=${mode === "view"}`,
        }),
      );
      const env = {
        API_CONTAINERS: { getByName: () => ({ fetch: getTarget }) },
        COMPUTER_CONTAINERS: { getByName: () => ({ fetch: computerFetch }) },
        SCREEN_PROXY_SECRET: "screen-secret",
      } as unknown as CloudflareEnv;
      const url = new URL(
        `https://app.example/novnc/session/${mode}/capability/computer-home/embed.html`,
      );
      url.searchParams.set("path", `novnc/session/${mode}/capability/websockify`);
      url.searchParams.set("view_only", String(mode === "view"));
      const response = await computerScreenRequest(new Request(url), env, "api-v1");
      expect(response.status).toBe(307);
      expect(getTarget).toHaveBeenCalledOnce();
      expect(computerFetch).not.toHaveBeenCalled();
      const corrected = new URL(response.headers.get("location")!);
      expect(corrected.origin).toBe(url.origin);
      expect(corrected.pathname).toBe(url.pathname);
      expect(corrected.searchParams.get("path")).toBe("websockify");
      expect(corrected.searchParams.get("view_only")).toBe(String(mode === "view"));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await computerScreenRequest(new Request(corrected), env, "api-v1")).status).toBe(200);
      expect(computerFetch).toHaveBeenCalledOnce();
    },
  );

  it("does not repair or forward an unauthorized viewer URL", async () => {
    const getByName = vi.fn();
    const env = {
      API_CONTAINERS: {
        getByName: () => ({ fetch: async () => new Response(null, { status: 403 }) }),
      },
      COMPUTER_CONTAINERS: { getByName },
      SCREEN_PROXY_SECRET: "screen-secret",
    } as unknown as CloudflareEnv;
    const response = await computerScreenRequest(
      new Request(
        "https://app.example/novnc/session/view/expired/computer-home/embed.html?path=wrong",
      ),
      env,
      "api-v1",
    );
    expect(response.status).toBe(403);
    expect(response.headers.has("location")).toBe(false);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("preserves the validated noVNC query outside the routed Computer id", async () => {
    const computerFetch = vi.fn(async (request: Request) => new Response(request.url));
    const getByName = vi.fn(() => ({ fetch: computerFetch }));
    const env = {
      API_CONTAINERS: {
        getByName: () => ({
          fetch: async () =>
            Response.json({
              hostname: "computer.internal",
              port: 6080,
              path: "/computer-home/embed.html?view_only=true",
            }),
        }),
      },
      COMPUTER_CONTAINERS: {
        getByName,
      },
      SCREEN_PROXY_SECRET: "screen-secret",
    } as unknown as CloudflareEnv;

    const response = await computerScreenRequest(
      new Request("https://app.example/novnc/session/view/capability/embed.html"),
      env,
      "api-v1",
    );

    expect(await response.text()).toBe("https://app.example/__port/6080/embed.html?view_only=true");
    expect(getByName).toHaveBeenCalledWith("v9:computer-home");
    expect(computerFetch).toHaveBeenCalledOnce();
  });

  it("proxies allowlisted remote Hybrid noVNC upstreams without using Computer DOs", async () => {
    const remoteFetch = vi.fn(
      async (_request: Request) =>
        new Response("remote-desktop", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "session=fake",
          },
        }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = remoteFetch as unknown as typeof fetch;
    const getByName = vi.fn();
    const env = {
      API_CONTAINERS: {
        getByName: () => ({
          fetch: async () =>
            Response.json({
              protocol: "https:",
              hostname: "computer.51proxy.org",
              port: 443,
              path: "/embed.html?view_only=true",
            }),
        }),
      },
      COMPUTER_CONTAINERS: { getByName },
      SCREEN_PROXY_SECRET: "screen-secret",
      SCREEN_UPSTREAM_ALLOWLIST: "computer.51proxy.org",
    } as unknown as CloudflareEnv;
    try {
      const response = await computerScreenRequest(
        new Request("https://app.example/novnc/session/view/capability/embed.html"),
        env,
        "api-v1",
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("remote-desktop");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(getByName).not.toHaveBeenCalled();
      expect(remoteFetch).toHaveBeenCalledOnce();
      const upstream = remoteFetch.mock.calls[0]![0] as Request;
      expect(new URL(upstream.url).origin).toBe("https://computer.51proxy.org");
      expect(upstream.headers.has("cookie")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects remote screen hosts outside the allowlist", async () => {
    const getByName = vi.fn();
    const env = {
      API_CONTAINERS: {
        getByName: () => ({
          fetch: async () =>
            Response.json({
              protocol: "https:",
              hostname: "evil.example",
              port: 443,
              path: "/embed.html",
            }),
        }),
      },
      COMPUTER_CONTAINERS: { getByName },
      SCREEN_PROXY_SECRET: "screen-secret",
      SCREEN_UPSTREAM_ALLOWLIST: "computer.51proxy.org",
    } as unknown as CloudflareEnv;
    const response = await computerScreenRequest(
      new Request("https://app.example/novnc/session/view/capability/embed.html"),
      env,
      "api-v1",
    );
    expect(response.status).toBe(403);
    expect(getByName).not.toHaveBeenCalled();
  });

});
