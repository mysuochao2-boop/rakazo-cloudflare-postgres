import { describe, expect, it } from "vitest";
import {
  isDirectScreenUrl,
  issueDirectScreenCapability,
  openDirectScreenCapability,
  resetDirectScreenCapabilityReuse,
  resolveScreenDirectConfig,
  SCREEN_DIRECT_TTL_MS,
  sealDirectScreenCapability,
} from "./screen-direct.js";

const secret = "s".repeat(40);
const config = { secret, origin: "https://computer.example" };
const scope = {
  botId: "bot-1",
  computerId: "computer-1",
  botGeneration: 2,
  computerGeneration: 3,
  controlLeaseId: null,
};
const now = 1_800_000_000_000;
const upstream = (viewOnly: boolean, port = 32768) =>
  `https://computer.example/screen/${port}/embed.html?path=websockify%3Ftoken%3Dprovider-tok&view_only=${viewOnly}`;

describe("screen direct config", () => {
  it("stays off unless flag, secret and https origin are all set", () => {
    expect(resolveScreenDirectConfig({})).toBeUndefined();
    expect(resolveScreenDirectConfig({ RAKAZO_SCREEN_DIRECT_SECRET: secret })).toBeUndefined();
    const warnings: string[] = [];
    expect(
      resolveScreenDirectConfig(
        { RAKAZO_SCREEN_DIRECT: "1", RAKAZO_SCREEN_DIRECT_SECRET: "short" },
        (message) => warnings.push(message),
      ),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(
      resolveScreenDirectConfig({
        RAKAZO_SCREEN_DIRECT: "1",
        RAKAZO_SCREEN_DIRECT_SECRET: secret,
        RAKAZO_SCREEN_DIRECT_ORIGIN: "http://computer.example",
      }),
    ).toBeUndefined();
    expect(
      resolveScreenDirectConfig({
        RAKAZO_SCREEN_DIRECT: "true",
        RAKAZO_SCREEN_DIRECT_SECRET: secret,
        RAKAZO_SCREEN_DIRECT_ORIGIN: "https://computer.example/",
      }),
    ).toEqual(config);
  });

  it("only matches supervisor embed URLs on the direct origin", () => {
    expect(isDirectScreenUrl(upstream(true), config)).toBe(true);
    expect(isDirectScreenUrl("https://other.example/screen/32768/embed.html", config)).toBe(false);
    expect(isDirectScreenUrl("https://computer.example/terminal/1/", config)).toBe(false);
    expect(isDirectScreenUrl("desktop://screen", config)).toBe(false);
  });
});

describe("direct screen capability", () => {
  it("round-trips port, provider socket and scope without exposing the provider token", () => {
    const url = new URL(sealDirectScreenCapability(upstream(false), config, scope, now));
    expect(url.origin).toBe("https://computer.example");
    expect(url.pathname).toMatch(/^\/direct\/control\/\d+\.[A-Za-z0-9_-]+\/embed\.html$/);
    expect(url.searchParams.get("view_only")).toBe("false");
    expect(url.searchParams.get("path")).toBe("websockify");
    expect(url.toString()).not.toContain("provider-tok");
    const socketPath = url.pathname.replace(/embed\.html$/, "websockify");
    expect(openDirectScreenCapability(socketPath, secret, now + 1000)).toEqual({
      policy: "control",
      expiresAt: now + SCREEN_DIRECT_TTL_MS,
      port: 32768,
      socket: "/websockify?token=provider-tok",
      rest: "websockify",
      scope,
    });
  });

  it("rejects expiry, tampering, wrong secret, policy swaps and path traversal", () => {
    const path = new URL(sealDirectScreenCapability(upstream(true), config, scope, now)).pathname;
    expect(openDirectScreenCapability(path, secret, now)?.policy).toBe("view");
    expect(openDirectScreenCapability(path, secret, now + SCREEN_DIRECT_TTL_MS)).toBeNull();
    expect(openDirectScreenCapability(path, "x".repeat(40), now)).toBeNull();
    expect(openDirectScreenCapability(path.replace("/view/", "/control/"), secret, now)).toBeNull();
    const [, , , capability] = path.split("/");
    const [exp, token] = capability!.split(".");
    expect(
      openDirectScreenCapability(
        `/direct/view/${Number(exp) + 1}.${token}/embed.html`,
        secret,
        now,
      ),
    ).toBeNull();
    expect(
      openDirectScreenCapability(`/direct/view/${exp}.${token}/../../etc/passwd`, secret, now),
    ).toBeNull();
    expect(
      openDirectScreenCapability("/novnc/session/view/1.abc/embed.html", secret, now),
    ).toBeNull();
  });

  it("refuses to seal URLs whose socket leaves the screen port", () => {
    expect(() =>
      sealDirectScreenCapability(
        "https://computer.example/screen/32768/embed.html?path=..%2F..%2Fscreen%2F7091%2Fwebsockify",
        config,
        scope,
        now,
      ),
    ).toThrow();
    expect(() =>
      sealDirectScreenCapability(
        "https://other.example/screen/32768/embed.html",
        config,
        scope,
        now,
      ),
    ).toThrow();
  });

  it("reuses a seal until the renew window and rotates afterwards", () => {
    resetDirectScreenCapabilityReuse();
    const first = issueDirectScreenCapability(upstream(true), config, scope, now);
    expect(issueDirectScreenCapability(upstream(true), config, scope, now + 30 * 60_000)).toBe(
      first,
    );
    expect(issueDirectScreenCapability(upstream(true), config, scope, now + 55 * 60_000)).not.toBe(
      first,
    );
    expect(
      issueDirectScreenCapability(upstream(true), config, { ...scope, botGeneration: 9 }, now),
    ).not.toBe(first);
  });
});
