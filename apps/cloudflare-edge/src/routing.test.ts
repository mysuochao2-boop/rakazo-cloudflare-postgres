import { describe, expect, it } from "vitest";
import { replicaCount, requestReplica } from "./routing.js";

describe("container routing", () => {
  it("routes the same key to the same replica", () => {
    const request = new Request("https://api.example.com/rpc", {
      headers: { "x-rakazo-routing-key": "space_123" },
    });
    expect(requestReplica(request, 4)).toBe(requestReplica(request, 4));
  });

  it("rejects invalid replica counts", () => {
    expect(() => replicaCount("0", "API_CONTAINER_REPLICAS", 4)).toThrow();
    expect(() => replicaCount("5", "API_CONTAINER_REPLICAS", 4)).toThrow();
    expect(() => replicaCount("many", "API_CONTAINER_REPLICAS", 4)).toThrow();
  });
});
