import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { R2AgentHomeStore } from "./home.js";
import { MemoryObjectStoreClient } from "./testing.js";

const context = {
  userId: "user-1",
  spaceId: "space-1",
  operationId: "operation-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "rakazo-r2-home-test-"));
  directories.push(created);
  return created;
}

describe("R2AgentHomeStore", () => {
  it("commits, restores, lists and exports immutable revisions", async () => {
    const objects = new MemoryObjectStoreClient();
    const store = new R2AgentHomeStore(objects, "test");
    const source = await directory();
    await writeFile(path.join(source, "memory.md"), "one");
    const first = await store.commit("bot-1", source, context);

    await writeFile(path.join(source, "memory.md"), "two");
    await writeFile(path.join(source, "notes.md"), "notes");
    const second = await store.commit("bot-1", source, context);
    expect(second).not.toBe(first);

    const restored = await directory();
    await store.restore("bot-1", first, restored, context);
    expect(await readFile(path.join(restored, "memory.md"), "utf8")).toBe("one");
    expect(await store.readFile("bot-1", "memory.md", context)).toBe("two");
    expect(await store.list("bot-1", "", context)).toEqual([
      { path: "memory.md", kind: "file", size: 3 },
      { path: "notes.md", kind: "file", size: 5 },
    ]);

    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);
    expect(exported).toEqual(["memory.md", "notes.md"]);
  });

  it("does not re-upload blobs the current revision already references", async () => {
    const objects = new MemoryObjectStoreClient();
    const puts: string[] = [];
    const put = objects.put.bind(objects);
    objects.put = async (key, value) => {
      puts.push(key);
      await put(key, value);
    };
    const store = new R2AgentHomeStore(objects, "test");
    const source = await directory();
    await writeFile(path.join(source, "a.md"), "alpha");
    await writeFile(path.join(source, "b.md"), "beta");
    await store.commit("bot-1", source, context);
    const blobPuts = () => puts.filter((key) => key.includes("/blobs/")).length;
    expect(blobPuts()).toBe(2);
    await writeFile(path.join(source, "b.md"), "beta two");
    await store.commit("bot-1", source, context);
    expect(blobPuts()).toBe(3);
    expect(await store.readFile("bot-1", "a.md", context)).toBe("alpha");
    expect(await store.readFile("bot-1", "b.md", context)).toBe("beta two");
  });

  it("packs small files into manifest v2 and still reads v1 revisions", async () => {
    const objects = new MemoryObjectStoreClient();
    const legacy = new R2AgentHomeStore(objects, "test");
    const source = await directory();
    await writeFile(path.join(source, "old.md"), "legacy");
    const v1 = await legacy.commit("bot-1", source, context);

    const packed = new R2AgentHomeStore(objects, "test", {
      packSmallFiles: true,
      packTargetBytes: 10,
    });
    await mkdir(path.join(source, "dir"), { recursive: true });
    await writeFile(path.join(source, "dir", "one.txt"), "first file");
    await writeFile(path.join(source, "dir", "two.txt"), "second");
    await writeFile(path.join(source, "dir", "dup.txt"), "second");
    const v2 = await packed.commit("bot-1", source, context);
    const manifest = JSON.parse(
      new TextDecoder().decode((await objects.get(`test/homes/bot-1/revisions/${v2}.json`))!.bytes),
    );
    expect(manifest.version).toBe(2);
    expect(manifest.files.find((file: { path: string }) => file.path === "old.md").pack).toBe(
      undefined,
    );
    const two = manifest.files.find((file: { path: string }) => file.path === "dir/two.txt");
    const dup = manifest.files.find((file: { path: string }) => file.path === "dir/dup.txt");
    expect(two.pack).toMatch(/^[0-9a-f]{64}$/);
    expect(dup).toMatchObject({ pack: two.pack, offset: two.offset });
    expect(
      [...objects.values.keys()].filter((key) => key.includes("/packs/")).length,
    ).toBeGreaterThanOrEqual(1);

    const checkout = await directory();
    expect(await legacy.checkout("bot-1", checkout, context)).toBe(v2);
    expect(await readFile(path.join(checkout, "dir", "one.txt"), "utf8")).toBe("first file");
    expect(await readFile(path.join(checkout, "dir", "dup.txt"), "utf8")).toBe("second");
    const exported: Record<string, string> = {};
    for await (const file of packed.exportHome("bot-1", context)) {
      exported[file.path] = new TextDecoder().decode(file.content);
    }
    expect(exported).toEqual({
      "dir/dup.txt": "second",
      "dir/one.txt": "first file",
      "dir/two.txt": "second",
      "old.md": "legacy",
    });
    const restored = await directory();
    await packed.restore("bot-1", v1, restored, context);
    expect(await readFile(path.join(restored, "old.md"), "utf8")).toBe("legacy");

    // Unchanged packed files are carried forward without new uploads.
    const before = objects.values.size;
    await packed.commit("bot-1", source, context);
    expect(objects.values.size).toBe(before + 1);
  });

  it("rejects a corrupt pack slice", async () => {
    const objects = new MemoryObjectStoreClient();
    const store = new R2AgentHomeStore(objects, "test", { packSmallFiles: true });
    const source = await directory();
    await writeFile(path.join(source, "a.md"), "alpha");
    await store.commit("bot-1", source, context);
    const packKey = [...objects.values.keys()].find((key) => key.includes("/packs/"))!;
    await objects.put(packKey, { bytes: new TextEncoder().encode("ALPHA") });
    await expect(store.readFile("bot-1", "a.md", context)).rejects.toThrow("corrupt");
  });

  it("rejects paths outside the home", async () => {
    const store = new R2AgentHomeStore(new MemoryObjectStoreClient(), "test");
    await expect(store.writeFile("bot-1", "../secret", "no", context)).rejects.toThrow(
      "Path escapes the bot home",
    );
  });

  it("does not follow symlinks already present in a checkout destination", async () => {
    const objects = new MemoryObjectStoreClient();
    const store = new R2AgentHomeStore(objects, "test");
    const source = await directory();
    await mkdir(path.join(source, "linked"));
    await writeFile(path.join(source, "linked", "escape.txt"), "home data");
    await store.commit("bot-1", source, context);

    const destination = await directory();
    const outside = await directory();
    await symlink(outside, path.join(destination, "linked"));
    await expect(store.checkout("bot-1", destination, context)).rejects.toThrow("symlink");
    await expect(readFile(path.join(outside, "escape.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
