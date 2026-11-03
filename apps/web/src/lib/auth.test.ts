import { describe, expect, it, vi } from "vitest";

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn((options: unknown) => options),
}));

vi.mock("better-auth/client/plugins", () => ({
  organizationClient: vi.fn(() => ({ id: "organization" })),
}));

describe("auth client", () => {
  it("bounds every auth request so a hung backend cannot leave useSession pending forever", async () => {
    const { createAuthClient } = await import("better-auth/react");
    await import("./auth.js");
    const options = vi.mocked(createAuthClient).mock.calls[0]?.[0] as {
      fetchOptions?: { timeout?: number };
    };
    expect(options.fetchOptions?.timeout).toBe(15_000);
  });
});
