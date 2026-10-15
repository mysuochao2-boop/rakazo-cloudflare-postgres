import { describe, expect, it, vi } from "vitest";
import { HttpObjectStoreClient, objectStoreFromEnv } from "./object-store.js";

describe("Cloudflare R2 object gateway", () => {
  it("authenticates object requests and decodes values", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("value", { headers: { "content-type": "text/plain" } }),
    );
    const objects = new HttpObjectStoreClient("https://api.example.test", "secret", fetchImpl);
    await expect(objects.get("path/value")).resolves.toEqual({
      bytes: new TextEncoder().encode("value"),
      contentType: "text/plain",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("key=path%2Fvalue");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("uses the gateway configuration without S3 credentials", () => {
    const selected = objectStoreFromEnv({
      OBJECT_STORE_GATEWAY_URL: "https://api.example.test",
      OBJECT_STORE_GATEWAY_SECRET: "secret",
      OBJECT_STORE_PREFIX: "test",
    });
    expect(selected?.objects).toBeInstanceOf(HttpObjectStoreClient);
    expect(selected?.prefix).toBe("test");
  });
});
