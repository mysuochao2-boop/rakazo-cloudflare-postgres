import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { quiesceBrowserProfilesCommand } from "@rakazo/core/node/desktop-runtime";
import { DockerSandboxProvider } from "./docker-sandbox.js";

/**
 * Cloudflare Computers expose the supervisor contract through the edge Worker.
 * Keeping the protocol shared preserves the provider-neutral Computer lifecycle.
 */
export class CloudflareSandboxProvider extends DockerSandboxProvider {
  constructor(gatewayUrl: string, gatewaySecret: string) {
    super(`${gatewayUrl.replace(/\/$/, "")}/__computers`, gatewaySecret, "cloudflare");
  }

  override async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    let exitCode = 1;
    for await (const event of this.execute(
      computer,
      { argv: ["bash", "-c", quiesceBrowserProfilesCommand()], timeoutMs: 30_000 },
      context,
    )) {
      if (event.type === "exit") exitCode = event.code;
    }
    if (exitCode !== 0) throw new Error("Cloudflare Computer browser checkpoint failed");
    yield* super.exportWorkspace(computer, context);
  }
}
