import type { PortableFile } from "@rakazo/adapter-kit";

/**
 * Reinstallable toolchains, package caches and dependency trees. A checkpoint that copies
 * them spends minutes moving thousands of files that `pnpm i`, `pip install` or the next
 * toolchain install recreates, while the VPS executes one `docker exec` per file.
 *
 * A pattern starting with `**\/` matches that directory name at any depth; any other pattern
 * is a path relative to the home and matches that file or everything below it.
 */
export const DEFAULT_WORKSPACE_EXPORT_EXCLUDES: readonly string[] = [
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn/cache",
  ".bun/install/cache",
  ".rustup",
  ".cargo",
  ".local/bin",
  ".local/gccroot",
  ".local/aptroot",
  ".local/include",
  ".local/lib",
  ".local/lib64",
  ".local/libexec",
  ".local/opt",
  ".local/share/pnpm",
  ".local/share/uv",
  ".local/share/pipx",
  ".local/share/virtualenvs",
  ".local/state/pnpm",
  "go/pkg/mod",
  "**/node_modules",
  "**/__pycache__",
  "**/.venv",
];

const PATTERN = /^(\*\*\/)?[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;

/**
 * `RAKAZO_WORKSPACE_EXPORT_EXCLUDES` adds comma or newline separated patterns;
 * `RAKAZO_WORKSPACE_EXPORT_EXCLUDE_DEFAULTS=0` drops the built-in list.
 * Patterns with unsupported characters, `.` or `..` segments are ignored.
 */
export function workspaceExportExcludes(env: NodeJS.ProcessEnv = process.env): string[] {
  const defaults = env.RAKAZO_WORKSPACE_EXPORT_EXCLUDE_DEFAULTS?.trim().toLowerCase();
  const useDefaults = !(defaults === "0" || defaults === "false" || defaults === "off");
  const extra = (env.RAKAZO_WORKSPACE_EXPORT_EXCLUDES ?? "")
    .split(/[,\n]/)
    .map((value) => value.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(isValidExcludePattern);
  return [...new Set([...(useDefaults ? DEFAULT_WORKSPACE_EXPORT_EXCLUDES : []), ...extra])];
}

export function isValidExcludePattern(pattern: string) {
  if (!PATTERN.test(pattern)) return false;
  return pattern
    .replace(/^\*\*\//, "")
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

/** True when `relative` (a home relative path) is, or is inside, an excluded path. */
export function isExcludedWorkspacePath(relative: string, excludes: readonly string[]) {
  const normalized = relative.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) return false;
  const segments = normalized.split("/");
  for (const pattern of excludes) {
    if (pattern.startsWith("**/")) {
      const name = pattern.slice(3);
      if (name.includes("/")) {
        if (normalized === name || normalized.startsWith(`${name}/`)) return true;
        if (normalized.includes(`/${name}/`) || normalized.endsWith(`/${name}`)) return true;
        continue;
      }
      if (segments.includes(name)) return true;
      continue;
    }
    if (normalized === pattern || normalized.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

const BLOCK = 512;

/**
 * Incremental reader for the tar stream `GET /computers/:id/workspace-archive` returns:
 * ustar/GNU regular files (GNU `L` long names and pax `path` records included), followed by
 * the end-of-archive blocks and a `RAKAZO_ARCHIVE_EXIT <code>` trailer. Directories, links
 * and devices are skipped. A stream that ends before the trailer is reported as truncated so
 * a half-written archive never becomes a checkpoint that silently drops files.
 */
export async function* readWorkspaceArchive(
  chunks: AsyncIterable<Uint8Array>,
  options: { maxFileBytes?: number } = {},
): AsyncIterable<PortableFile> {
  let buffer: Buffer = Buffer.alloc(0);
  let ended = false;
  const iterator = chunks[Symbol.asyncIterator]();
  const fill = async (size: number) => {
    while (buffer.length < size && !ended) {
      const next = await iterator.next();
      if (next.done) ended = true;
      else buffer = buffer.length ? Buffer.concat([buffer, next.value]) : Buffer.from(next.value);
    }
    return buffer.length >= size;
  };
  const take = (size: number) => {
    const head = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return head;
  };
  let longName: string | undefined;
  let paxPath: string | undefined;
  for (;;) {
    if (!(await fill(BLOCK))) throw new Error("workspace archive is truncated");
    const header = take(BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!validChecksum(header)) throw new Error("workspace archive header checksum mismatch");
    const size = parseNumeric(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const limit = options.maxFileBytes;
    if (type === "L" || type === "x") {
      if (size > 1024 * 1024) throw new Error("workspace archive metadata is too large");
      if (!(await fill(padded))) throw new Error("workspace archive is truncated");
      const body = take(padded).subarray(0, size);
      if (type === "L") longName = cString(body);
      else paxPath = paxRecord(body, "path") ?? paxPath;
      continue;
    }
    const name = paxPath ?? longName ?? ustarName(header);
    longName = undefined;
    paxPath = undefined;
    const regular = type === "0" || type === "\0" || type === "7";
    if (!regular || (limit !== undefined && size > limit)) {
      await skip(padded);
      continue;
    }
    if (!(await fill(padded))) throw new Error("workspace archive is truncated");
    const content = new Uint8Array(take(padded).subarray(0, size));
    const relative = name.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => part === ".." || part === ".")) continue;
    const mode = parseNumeric(header.subarray(100, 108));
    yield { path: relative, content, ...((mode & 0o100) !== 0 ? { executable: true } : {}) };
  }
  // GNU tar pads the archive with zero blocks; the trailer follows them.
  while (!ended) await fill(buffer.length + 64 * 1024);
  const trailer = buffer.toString("latin1").replace(/^\0+/, "").trim();
  const code = trailer.match(/^RAKAZO_ARCHIVE_EXIT (\d+)$/)?.[1];
  if (code === undefined) throw new Error("workspace archive is truncated");
  // tar exits 1 when a file changed while it was read; the archive itself is complete.
  if (code !== "0" && code !== "1") throw new Error(`workspace archive failed with exit ${code}`);

  async function skip(bytes: number) {
    let remaining = bytes;
    while (remaining > 0) {
      if (!(await fill(Math.min(remaining, 64 * 1024)))) {
        throw new Error("workspace archive is truncated");
      }
      remaining -= take(Math.min(remaining, buffer.length)).length;
    }
  }
}

function validChecksum(header: Buffer) {
  const expected = parseNumeric(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  return sum === expected;
}

function parseNumeric(field: Buffer) {
  if ((field[0]! & 0x80) !== 0) {
    // GNU base-256 for sizes past 8 GiB.
    let value = 0;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]!;
    return value;
  }
  const text = cString(field).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function cString(bytes: Buffer) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function ustarName(header: Buffer) {
  const name = cString(header.subarray(0, 100));
  const magic = header.subarray(257, 262).toString("latin1");
  const prefix = magic === "ustar" ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function paxRecord(body: Buffer, key: string) {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString("latin1"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === key) return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
}
