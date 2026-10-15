import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { R2AgentHomeStore } from "./home.js";
import type { ObjectStoreClient } from "./object-store.js";
import { objectKey } from "./object-store.js";

export interface FileMigrationResult {
  artifactBytes: number;
  artifacts: number;
  homes: number;
}

interface FileMigrationInput {
  dataDir: string;
  objects: ObjectStoreClient;
  prefix: string;
  apply: boolean;
}

export async function migrateLocalFiles(input: FileMigrationInput): Promise<FileMigrationResult> {
  const result: FileMigrationResult = { artifactBytes: 0, artifacts: 0, homes: 0 };
  await migrateHomes(input, result);
  await migrateArtifacts(input, result);
  return result;
}

async function migrateHomes(input: FileMigrationInput, result: FileMigrationResult): Promise<void> {
  const root = path.join(input.dataDir, "homes");
  const entries = await safeReadDir(root);
  const store = new R2AgentHomeStore(input.objects, input.prefix);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    result.homes += 1;
    if (!input.apply) continue;
    const context: AdapterContext = {
      userId: "migration",
      spaceId: "migration",
      operationId: `migrate-home:${entry.name}`,
      traceId: "cloudflare-file-migration",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    };
    await store.commit(entry.name, path.join(root, entry.name), context);
  }
}

async function migrateArtifacts(
  input: FileMigrationInput,
  result: FileMigrationResult,
): Promise<void> {
  const root = path.join(input.dataDir, "artifacts");
  for (const space of await safeReadDir(root)) {
    if (!space.isDirectory() || space.isSymbolicLink()) continue;
    const spaceDir = path.join(root, space.name);
    for (const artifact of await safeReadDir(spaceDir)) {
      if (!artifact.isFile() || artifact.isSymbolicLink()) continue;
      const source = path.join(spaceDir, artifact.name);
      const info = await lstat(source);
      result.artifacts += 1;
      result.artifactBytes += info.size;
      if (!input.apply) continue;
      const handle = await open(source, "r");
      try {
        const bytes = new Uint8Array(await handle.readFile());
        const digest = createHash("sha256").update(bytes).digest("hex");
        const key = objectKey(input.prefix, "spaces", space.name, "artifacts", artifact.name);
        await input.objects.put(key, { bytes, contentType: "application/octet-stream" });
        const stored = await input.objects.get(key);
        if (!stored || createHash("sha256").update(stored.bytes).digest("hex") !== digest) {
          throw new Error(`Artifact verification failed: ${space.name}/${artifact.name}`);
        }
      } finally {
        await handle.close();
      }
    }
  }
}

async function safeReadDir(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
