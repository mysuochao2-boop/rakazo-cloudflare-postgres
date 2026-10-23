import { once } from "node:events";
import http from "node:http";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { sealDirectScreenCapability } from "@rakazo/core/node/screen-direct";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedScreenPortCheck,
  directScreenUpgradeDecision,
  handleDirectScreenRequest,
  handleDirectScreenUpgrade,
  screenDirectSupervisorConfig,
} from "./screen-direct.js";

const secret = "d".repeat(40);
const scope = {
  botId: "bot-1",
  computerId: "computer-1",
  botGeneration: 1,
  computerGeneration: 1,
  controlLeaseId: "lease-1",
};
const config = screenDirectSupervisorConfig({
  RAKAZO_SCREEN_DIRECT_SECRET: secret,
  PUBLIC_SCREEN_BASE: "https://computer.example",
  RAKAZO_SCREEN_DIRECT_FRAME_ANCESTORS: "https://bot.example",
})!;

function capabilityPath(port: number, rest: string, now = Date.now()) {
  const sealed = sealDirectScreenCapability(
    `https://computer.example/screen/${port}/embed.html?path=websockify%3Ftoken%3Dprov&view_only=false`,
    { secret, origin: "https://computer.example" },
    scope,
    now,
  );
  return new URL(sealed).pathname.replace(/embed\.html$/, rest);
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("screenDirectSupervisorConfig", () => {
  it("is off without a secret and validates origins", () => {
    expect(screenDirectSupervisorConfig({})).toBeUndefined();
    expect(() => screenDirectSupervisorConfig({ RAKAZO_SCREEN_DIRECT_SECRET: "short" })).toThrow();
    expect(() => screenDirectSupervisorConfig({ RAKAZO_SCREEN_DIRECT_SECRET: secret })).toThrow(
      /PUBLIC_SCREEN_BASE/,
    );
    expect(() =>
      screenDirectSupervisorConfig({
        RAKAZO_SCREEN_DIRECT_SECRET: secret,
        RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS: "https://a.example/path",
      }),
    ).toThrow();
    expect(config.allowedOrigins).toEqual(new Set(["https://computer.example"]));
    expect(config.frameAncestors).toBe("'self' https://bot.example");
    expect(config.upstreamHost).toBe("127.0.0.1");
  });
});

describe("handleDirectScreenRequest", () => {
  const ok = async () => true;

  it("serves noVNC files from the sealed loopback port with security headers", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response("<html>", {
        headers: { "content-type": "text/html", "set-cookie": "x=1" },
      });
    }) as typeof fetch;
    const response = await handleDirectScreenRequest(
      new Request(`https://computer.example${capabilityPath(32770, "embed.html")}?view_only=false`),
      config,
      ok,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>");
    expect(seen).toEqual(["http://127.0.0.1:32770/embed.html"]);
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://bot.example",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses disabled config, bad tokens, unmanaged ports, writes and plain websockify", async () => {
    const fetchImpl = (async () => new Response("x")) as typeof fetch;
    const url = `https://computer.example${capabilityPath(32770, "embed.html")}`;
    expect(
      (await handleDirectScreenRequest(new Request(url), undefined, ok, fetchImpl)).status,
    ).toBe(404);
    expect(
      (
        await handleDirectScreenRequest(
          new Request(url.replace(/\.[A-Za-z0-9_-]{8}/, ".AAAAAAAA")),
          config,
          ok,
          fetchImpl,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleDirectScreenRequest(new Request(url), config, async () => false, fetchImpl))
        .status,
    ).toBe(403);
    expect(
      (await handleDirectScreenRequest(new Request(url, { method: "POST" }), config, ok, fetchImpl))
        .status,
    ).toBe(405);
    expect(
      (
        await handleDirectScreenRequest(
          new Request(`https://computer.example${capabilityPath(32770, "websockify")}`),
          config,
          ok,
          fetchImpl,
        )
      ).status,
    ).toBe(426);
  });
});

function fakeRequest(path: string, headers: Record<string, string>) {
  return { url: path, headers } as unknown as http.IncomingMessage;
}

describe("directScreenUpgradeDecision", () => {
  const headers = {
    origin: "https://computer.example",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    "sec-websocket-protocol": "binary",
  };

  it("accepts a valid socket capability from an allowed origin", () => {
    const decision = directScreenUpgradeDecision(
      fakeRequest(capabilityPath(32771, "websockify"), headers),
      config,
    );
    expect(typeof decision).toBe("object");
    expect(decision).toMatchObject({ protocol: "binary", capability: { port: 32771 } });
  });

  it("rejects foreign, null and missing origins, non-socket paths and header injection", () => {
    const path = capabilityPath(32771, "websockify");
    for (const origin of ["https://evil.example", "null"]) {
      expect(directScreenUpgradeDecision(fakeRequest(path, { ...headers, origin }), config)).toBe(
        "403 Forbidden",
      );
    }
    const { origin: _origin, ...noOrigin } = headers;
    expect(directScreenUpgradeDecision(fakeRequest(path, noOrigin), config)).toBe("403 Forbidden");
    expect(
      directScreenUpgradeDecision(
        fakeRequest(capabilityPath(32771, "embed.html"), headers),
        config,
      ),
    ).toBe("403 Forbidden");
    expect(
      directScreenUpgradeDecision(
        fakeRequest(path, { ...headers, "sec-websocket-protocol": "binary\r\nX-Evil: 1" }),
        config,
      ),
    ).toBe("400 Bad Request");
  });
});

async function listen(server: Server | http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

describe("handleDirectScreenUpgrade", () => {
  it("tunnels to websockify with the provider token and closes at expiry", async () => {
    const upstreamRequests: string[] = [];
    const upstream = createServer((socket) => {
      socket.once("data", (chunk) => {
        upstreamRequests.push(chunk.toString());
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        socket.on("data", (data) => socket.write(data));
      });
    });
    const upstreamPort = await listen(upstream);
    const front = http.createServer();
    const now = Date.now();
    // Expire 300 ms from now: sealed TTL is 1h, so seal "in the past".
    const path = capabilityPath(upstreamPort, "websockify", now - 60 * 60_000 + 300);
    front.on("upgrade", (request, socket, head) => {
      void handleDirectScreenUpgrade(
        request,
        socket,
        head,
        config,
        async (port) => port === upstreamPort,
      );
    });
    const frontPort = await listen(front);
    const client: Socket = connect(frontPort, "127.0.0.1");
    closers.push(() => client.destroy());
    await once(client, "connect");
    client.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: computer.example`,
        "Origin: https://computer.example",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    let received = "";
    client.on("data", (data) => {
      received += data.toString();
      if (received.includes("\r\n\r\n") && !received.includes("ping")) client.write("ping");
    });
    await once(client, "close");
    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("ping");
    expect(upstreamRequests[0]).toMatch(/^GET \/websockify\?token=prov HTTP\/1\.1\r\n/);
    expect(upstreamRequests[0]).not.toContain("Origin:");
  });

  it("refuses unmanaged ports before dialing", async () => {
    const front = http.createServer();
    front.on("upgrade", (request, socket, head) => {
      void handleDirectScreenUpgrade(request, socket, head, config, async () => false);
    });
    const frontPort = await listen(front);
    const client = connect(frontPort, "127.0.0.1");
    closers.push(() => client.destroy());
    await once(client, "connect");
    client.write(
      `GET ${capabilityPath(1234, "websockify")} HTTP/1.1\r\nHost: x\r\nOrigin: https://computer.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    let received = "";
    client.on("data", (data) => {
      received += data.toString();
    });
    await once(client, "close");
    expect(received).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });
});

describe("cachedScreenPortCheck", () => {
  it("caches managed ports and refreshes on a stale miss", async () => {
    let calls = 0;
    let ports = [32768];
    const check = cachedScreenPortCheck(
      async () => {
        calls++;
        return ports;
      },
      60_000,
      0,
    );
    expect(await check(32768)).toBe(true);
    expect(await check(32768)).toBe(true);
    expect(calls).toBe(1);
    ports = [32768, 32769];
    expect(await check(32769)).toBe(true);
    expect(calls).toBe(2);
  });
});
