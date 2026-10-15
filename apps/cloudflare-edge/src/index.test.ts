import { describe, expect, it } from "vitest";
import type { CloudflareEnv } from "./env.js";
import worker from "./index.js";

const env = {
  RUNTIME_DISPATCH_SECRET: "runtime-secret",
  REALTIME_FANOUT_SECRET: "realtime-secret",
  OBJECT_STORE_GATEWAY_SECRET: "object-gateway-secret",
  COMPUTER_GATEWAY_SECRET: "computer-gateway-secret",
} as CloudflareEnv;

type WorkerRequest = Parameters<typeof worker.fetch>[0];

function workerRequest(url: string, init?: RequestInit): WorkerRequest {
  return new Request(url, init) as WorkerRequest;
}

describe("internal edge routes", () => {
  it("does not expose runtime dispatch without its bearer", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__runtime/dispatch", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("does not expose realtime publication without its bearer", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__realtime/publish", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("does not expose the R2 gateway without its bearer", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__objects/list", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("does not expose the Computer gateway without its bearer", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__computers/computers", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects oversized runtime commands before dispatch", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__runtime/dispatch", {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-secret",
          "content-length": "9000",
        },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(413);
  });

  it("keeps unknown internal routes away from API containers", async () => {
    const response = await worker.fetch(
      workerRequest("https://api.example.com/__runtime/unknown"),
      env,
    );
    expect(response.status).toBe(404);
  });
});
