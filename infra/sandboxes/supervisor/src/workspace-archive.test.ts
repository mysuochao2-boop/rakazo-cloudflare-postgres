import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceArchiveCommand, workspaceArchiveOptions } from "./supervisor-logic.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-home-archive-"));
  roots.push(root);
  const files: Record<string, string> = {
    "notes.md": "notes",
    "workspace/app/src/index.ts": "export {}",
    "workspace/app/node_modules/react/index.js": "react",
    ".local/bin/node": "binary",
    ".local/share/keyrings/login": "keep",
    ".cache/pip/wheel": "cache",
    ".browser-profiles/chromium-bot-1/Default/Cache/data_0": "cache",
    ".browser-profiles/chromium-bot-1/Default/Cookies": "cookies",
    "workspace/big.bin": "x".repeat(64),
    "it's quoted.txt": "quote",
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

describe("workspace archive", () => {
  it("validates exclude patterns and the size cap", () => {
    expect(
      workspaceArchiveOptions({ exclude: ["./.cache/", "**/node_modules"], maxFileBytes: "10" }),
    ).toEqual({ excludes: [".cache", "**/node_modules"], maxFileBytes: 10 });
    expect(() => workspaceArchiveOptions({ exclude: ["../etc"] })).toThrow("invalid exclude");
    expect(() => workspaceArchiveOptions({ exclude: ["$(id)"] })).toThrow("invalid exclude");
    expect(() => workspaceArchiveOptions({ exclude: [], maxFileBytes: "-1" })).toThrow(
      "maxFileBytes",
    );
  });

  it("tars the home with excluded directories pruned and a completion trailer", async () => {
    const root = await home();
    const [command, ...args] = workspaceArchiveCommand(
      [".local/bin", ".cache", "**/node_modules"],
      32,
    );
    const result = spawnSync(command!, args, {
      env: { ...process.env, RAKAZO_ARCHIVE_ROOT: root },
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    const output = result.stdout as Buffer;
    const trailer = output
      .toString("latin1")
      .replace(/\0+/g, "")
      .match(/RAKAZO_ARCHIVE_EXIT \d+\n$/);
    expect(trailer?.[0]).toBe("RAKAZO_ARCHIVE_EXIT 0\n");
    const tarBytes = output.subarray(0, output.length - "RAKAZO_ARCHIVE_EXIT 0\n".length);
    const listed = execFileSync("tar", ["-tf", "-"], { input: tarBytes })
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((name) => name.replace(/^\.\//, ""))
      .sort();
    expect(listed).toEqual([
      ".browser-profiles/chromium-bot-1/Default/Cookies",
      ".local/share/keyrings/login",
      "it's quoted.txt",
      "notes.md",
      "workspace/app/src/index.ts",
    ]);
  });
});
