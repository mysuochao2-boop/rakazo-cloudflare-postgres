import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_EXPORT_EXCLUDES,
  isExcludedWorkspacePath,
  readWorkspaceArchive,
  workspaceExportExcludes,
} from "./workspace-export.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function* chunked(bytes: Buffer, size = 700): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield new Uint8Array(bytes.subarray(offset, offset + size));
  }
}

async function collect(
  stream: AsyncIterable<{ path: string; content: Uint8Array; executable?: boolean }>,
) {
  const files: Record<string, { text: string; executable: boolean }> = {};
  for await (const file of stream) {
    files[file.path] = {
      text: Buffer.from(file.content).toString("utf8"),
      executable: file.executable === true,
    };
  }
  return files;
}

describe("workspace export excludes", () => {
  it("matches root paths, nested directory names and keeps user files", () => {
    const excludes = [...DEFAULT_WORKSPACE_EXPORT_EXCLUDES];
    expect(isExcludedWorkspacePath(".local/bin/node", excludes)).toBe(true);
    expect(isExcludedWorkspacePath(".local/gccroot", excludes)).toBe(true);
    expect(isExcludedWorkspacePath(".cache/pip/x", excludes)).toBe(true);
    expect(isExcludedWorkspacePath("workspace/app/node_modules/react/index.js", excludes)).toBe(
      true,
    );
    expect(isExcludedWorkspacePath(".rustup", excludes)).toBe(true);
    expect(isExcludedWorkspacePath(".local/share/keyrings/a", excludes)).toBe(false);
    expect(isExcludedWorkspacePath("workspace/notes.md", excludes)).toBe(false);
    expect(isExcludedWorkspacePath("workspace/.cache-notes", excludes)).toBe(false);
  });

  it("reads extra patterns from env and can drop the defaults", () => {
    expect(
      workspaceExportExcludes({
        RAKAZO_WORKSPACE_EXPORT_EXCLUDES: "data/big, **/dist,../escape,bad pattern;x",
      }),
    ).toEqual([...DEFAULT_WORKSPACE_EXPORT_EXCLUDES, "data/big", "**/dist"]);
    expect(
      workspaceExportExcludes({
        RAKAZO_WORKSPACE_EXPORT_EXCLUDE_DEFAULTS: "0",
        RAKAZO_WORKSPACE_EXPORT_EXCLUDES: "./tmp/",
      }),
    ).toEqual(["tmp"]);
  });
});

describe("readWorkspaceArchive", () => {
  async function archive(trailer = "RAKAZO_ARCHIVE_EXIT 0\n") {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-archive-test-"));
    directories.push(root);
    const long = `workspace/${"deep-directory-name/".repeat(8)}file.txt`;
    await mkdir(path.join(root, path.dirname(long)), { recursive: true });
    await writeFile(path.join(root, long), "long name");
    await writeFile(path.join(root, "workspace/run.sh"), "#!/bin/sh\n");
    await chmod(path.join(root, "workspace/run.sh"), 0o755);
    await writeFile(path.join(root, "notes.md"), "notes");
    await symlink("notes.md", path.join(root, "link.md"));
    const tar = execFileSync("tar", ["--format=gnu", "-C", root, "-cf", "-", "."]);
    return { long, bytes: Buffer.concat([tar, Buffer.from(trailer)]) };
  }

  it("yields regular files with long names and executable bits", async () => {
    const { long, bytes } = await archive();
    const files = await collect(readWorkspaceArchive(chunked(bytes)));
    expect(files).toEqual({
      [long]: { text: "long name", executable: false },
      "notes.md": { text: "notes", executable: false },
      "workspace/run.sh": { text: "#!/bin/sh\n", executable: true },
    });
  });

  it("rejects a stream without the completion trailer", async () => {
    const { bytes } = await archive("");
    await expect(collect(readWorkspaceArchive(chunked(bytes)))).rejects.toThrow("truncated");
    await expect(collect(readWorkspaceArchive(chunked(bytes.subarray(0, 1536))))).rejects.toThrow(
      "truncated",
    );
  });

  it("rejects a failed archive and accepts files changed while read", async () => {
    await expect(
      collect(readWorkspaceArchive(chunked((await archive("RAKAZO_ARCHIVE_EXIT 2\n")).bytes))),
    ).rejects.toThrow("exit 2");
    const changed = await collect(
      readWorkspaceArchive(chunked((await archive("RAKAZO_ARCHIVE_EXIT 1\n")).bytes)),
    );
    expect(Object.keys(changed)).toHaveLength(3);
  });

  it("skips files above the size cap", async () => {
    const { bytes } = await archive();
    const files = await collect(readWorkspaceArchive(chunked(bytes), { maxFileBytes: 6 }));
    expect(Object.keys(files).sort()).toEqual(["notes.md"]);
  });
});
