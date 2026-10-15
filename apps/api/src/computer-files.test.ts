import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

describe("Team Computer file initialization", () => {
  function fixture(scope = "team", exitCode = 0) {
    let prepared = scope !== "team";
    const execute = vi.fn(async function* () {
      prepared = exitCode === 0;
      yield { type: "exit" as const, code: exitCode };
    });
    const listFiles = vi.fn(async () => {
      if (!prepared) throw new Error("sandbox file listing failed: 404");
      return [];
    });
    const deps = {
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({
            id: "new-bot",
            computer: {
              id: "shared-computer",
              kind: "cloudflare",
              scope,
              state: "running",
              providerRef: "shared-home",
              homeKey: "shared-home",
            },
          })),
        },
        computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
      },
      sandbox: { execute, listFiles },
      jobs: { enqueue: vi.fn(async () => {}) },
      env: { sandboxProvider: "cloudflare" },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space",
      userId: "user",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    return { client, execute, listFiles };
  }

  it("creates a joining bot's home before listing an already-running Team Computer", async () => {
    const { client, execute, listFiles } = fixture();
    await expect(client.computer.files({ botId: "new-bot", path: "" })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      { argv: ["mkdir", "-p", "shared", "bots/new-bot"] },
      expect.objectContaining({ botId: "new-bot", spaceId: "space" }),
    );
    expect(listFiles).toHaveBeenCalledWith(expect.anything(), "bots/new-bot", expect.anything());
  });

  it("does not create Team folders on a private computer", async () => {
    const { client, execute } = fixture("dedicated");
    await expect(client.computer.files({ botId: "new-bot", path: "" })).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not turn preparation failures into an empty successful listing", async () => {
    const { client, listFiles } = fixture("team", 1);
    await expect(client.computer.files({ botId: "new-bot", path: "" })).rejects.toThrow();
    expect(listFiles).not.toHaveBeenCalled();
  });
});
