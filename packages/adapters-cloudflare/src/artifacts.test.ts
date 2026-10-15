import { describe, expect, it } from "vitest";
import { R2ArtifactStore } from "./artifacts.js";
import { MemoryObjectStoreClient } from "./testing.js";

const context = {
  userId: "user-1",
  spaceId: "space-1",
  operationId: "operation-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

describe("R2ArtifactStore", () => {
  it("stores artifacts under their space and returns a content hash", async () => {
    const objects = new MemoryObjectStoreClient();
    const store = new R2ArtifactStore(objects, "test");
    const created = await store.put(
      { name: "hello.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello") },
      context,
    );

    expect(created.hash).toHaveLength(64);
    expect(new TextDecoder().decode(await store.get(created.id, context))).toBe("hello");
    await store.remove(created.id, context);
    await expect(store.get(created.id, context)).rejects.toThrow("Artifact not found");
  });
});
