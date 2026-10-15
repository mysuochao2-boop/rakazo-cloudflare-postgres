import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, ArtifactPut, ArtifactStore } from "@rakazo/adapter-kit";
import type { ObjectStoreClient } from "./object-store.js";
import { objectKey } from "./object-store.js";

export class R2ArtifactStore implements ArtifactStore {
  constructor(
    private readonly objects: ObjectStoreClient,
    private readonly prefix = "rakazo",
  ) {}

  describe() {
    return {
      id: "cloudflare-r2-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: false },
    };
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const hash = createHash("sha256").update(artifact.bytes).digest("hex");
    await this.objects.put(this.key(context.spaceId, id), {
      bytes: artifact.bytes,
      contentType: artifact.mimeType,
    });
    return { id, hash };
  }

  async get(id: string, context: AdapterContext): Promise<Uint8Array> {
    const value = await this.objects.get(this.key(context.spaceId, id));
    if (!value) throw new Error("Artifact not found");
    return value.bytes;
  }

  async remove(id: string, context: AdapterContext): Promise<void> {
    await this.objects.delete(this.key(context.spaceId, id));
  }

  private key(spaceId: string, id: string): string {
    return objectKey(this.prefix, "spaces", spaceId, "artifacts", id);
  }
}
