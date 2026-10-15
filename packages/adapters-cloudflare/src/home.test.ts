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
