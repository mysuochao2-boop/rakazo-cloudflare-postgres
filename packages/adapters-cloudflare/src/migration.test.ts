import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLocalFiles } from "./migration.js";
import { MemoryObjectStoreClient } from "./testing.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("file migration", () => {
  it("backfills homes and artifact ids without changing their identity", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-file-migration-"));
    directories.push(dataDir);
    await mkdir(path.join(dataDir, "homes", "bot-1"), { recursive: true });
    await writeFile(path.join(dataDir, "homes", "bot-1", "memory.md"), "memory");
    await mkdir(path.join(dataDir, "artifacts", "space-1"), { recursive: true });
    await writeFile(path.join(dataDir, "artifacts", "space-1", "artifact-1"), "artifact");
    const objects = new MemoryObjectStoreClient();

    const result = await migrateLocalFiles({ dataDir, objects, prefix: "test", apply: true });
    expect(result).toEqual({ homes: 1, artifacts: 1, artifactBytes: 8 });
    expect(objects.values.has("test/spaces/space-1/artifacts/artifact-1")).toBe(true);
    expect(objects.values.has("test/homes/bot-1/current.json")).toBe(true);
  });
});
