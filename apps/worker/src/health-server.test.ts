import { afterEach, describe, expect, it } from "vitest";
import type { WorkerHealthServer } from "./health-server.js";
import { startWorkerHealthServer } from "./health-server.js";

let server: WorkerHealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("worker health server", () => {
  it("exposes only the readiness endpoint", async () => {
    server = await startWorkerHealthServer({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(`${origin}/internal`)).status).toBe(404);
  });
});
