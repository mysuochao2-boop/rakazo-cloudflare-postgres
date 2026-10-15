import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, AgentHomeStore, PortableFile } from "@rakazo/adapter-kit";
import type { ObjectStoreClient } from "./object-store.js";
import { objectKey } from "./object-store.js";

interface HomeFile {
  path: string;
  hash: string;
  size: number;
}

interface HomeManifest {
  version: 1;
  botId: string;
  revision: string;
  files: HomeFile[];
}

interface HomePointer {
  revision: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class R2AgentHomeStore implements AgentHomeStore {
  private readonly botWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly objects: ObjectStoreClient,
    private readonly prefix = "rakazo",
  ) {}

  describe() {
    return {
      id: "cloudflare-r2-home",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: true },
    };
  }

  async checkout(botId: string, dest: string, _context: AdapterContext): Promise<string> {
    await this.waitForBotWrite(botId);
    const manifest = await this.currentManifest(botId);
    await mkdir(dest, { recursive: true });
    if (!manifest) return "empty";
    await Promise.all(
      manifest.files.map(async (file) => {
        const target = await safeWriteTarget(dest, file.path);
        const value = await this.objects.get(this.blobKey(file.hash));
        if (!value) throw new Error(`Agent home blob is missing: ${file.hash}`);
        const handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(value.bytes);
        } finally {
          await handle.close();
        }
      }),
    );
    return manifest.revision;
  }

  async commit(botId: string, src: string, _context: AdapterContext): Promise<string> {
    return this.withBotWrite(botId, async () => {
      const revision = `rev-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const files: HomeFile[] = [];
      for await (const file of walkFiles(src, src)) {
        const hash = createHash("sha256").update(file.content).digest("hex");
        await this.objects.put(this.blobKey(hash), {
          bytes: file.content,
          contentType: "application/octet-stream",
        });
        files.push({ path: file.path, hash, size: file.content.byteLength });
      }
      files.sort((left, right) => left.path.localeCompare(right.path));
      const manifest: HomeManifest = { version: 1, botId, revision, files };
      await this.putJson(this.manifestKey(botId, revision), manifest);
      await this.putJson(this.pointerKey(botId), { revision } satisfies HomePointer);
      return revision;
    });
  }

  async restore(
    botId: string,
    revision: string,
    dest: string,
    _context: AdapterContext,
  ): Promise<void> {
    const manifest = await this.readJson<HomeManifest>(this.manifestKey(botId, revision));
    if (!manifest) throw new Error("Agent home revision not found");
    await mkdir(dest, { recursive: true });
    for (const file of manifest.files) {
      const value = await this.objects.get(this.blobKey(file.hash));
      if (!value) throw new Error(`Agent home blob is missing: ${file.hash}`);
      const target = await safeWriteTarget(dest, file.path);
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(value.bytes);
      } finally {
        await handle.close();
      }
    }
  }

  async *exportHome(
    botId: string,
    _context: AdapterContext,
    options: { directory?: string; skipHidden?: boolean } = {},
  ): AsyncIterable<PortableFile> {
    await this.waitForBotWrite(botId);
    const manifest = await this.currentManifest(botId);
    if (!manifest) return;
    const directory = normalizeRelative(options.directory ?? "");
    for (const file of manifest.files) {
      if (!withinDirectory(file.path, directory)) continue;
      const relative = directory ? file.path.slice(directory.length + 1) : file.path;
      if (options.skipHidden && relative.split("/")[0]?.startsWith(".")) continue;
      const value = await this.objects.get(this.blobKey(file.hash));
      if (!value) throw new Error(`Agent home blob is missing: ${file.hash}`);
      yield { path: relative, content: value.bytes };
    }
  }

  async readFile(
    botId: string,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string> {
    await this.waitForBotWrite(botId);
    const normalized = normalizeRelative(filePath);
    const manifest = await this.currentManifest(botId);
    const file = manifest?.files.find((candidate) => candidate.path === normalized);
    if (!file) throw new Error("Agent home file not found");
    if (options?.maxBytes !== undefined && file.size > options.maxBytes) {
      throw new Error(`agent home file exceeds ${options.maxBytes} bytes`);
    }
    const value = await this.objects.get(this.blobKey(file.hash));
    if (!value) throw new Error(`Agent home blob is missing: ${file.hash}`);
    return decoder.decode(value.bytes);
  }

  async writeFile(
    botId: string,
    filePath: string,
    content: string,
    context: AdapterContext,
  ): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-r2-home-"));
    try {
      await this.checkout(botId, directory, context);
      const target = await safeWriteTarget(directory, normalizeRelative(filePath));
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      await this.commit(botId, directory, context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async list(botId: string, dirPath: string, _context: AdapterContext) {
    await this.waitForBotWrite(botId);
    const directory = normalizeRelative(dirPath);
    const manifest = await this.currentManifest(botId);
    const entries = new Map<string, { path: string; kind: "file" | "dir"; size: number }>();
    for (const file of manifest?.files ?? []) {
      if (!withinDirectory(file.path, directory)) continue;
      const relative = directory ? file.path.slice(directory.length + 1) : file.path;
      const [name, ...rest] = relative.split("/");
      if (!name) continue;
      const listedPath = directory ? `${directory}/${name}` : name;
      entries.set(
        name,
        rest.length > 0
          ? { path: listedPath, kind: "dir", size: 0 }
          : { path: listedPath, kind: "file", size: file.size },
      );
    }
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async currentManifest(botId: string): Promise<HomeManifest | null> {
    const pointer = await this.readJson<HomePointer>(this.pointerKey(botId));
    return pointer ? this.readJson<HomeManifest>(this.manifestKey(botId, pointer.revision)) : null;
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.objects.put(key, {
      bytes: encoder.encode(JSON.stringify(value)),
      contentType: "application/json",
    });
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const value = await this.objects.get(key);
    return value ? (JSON.parse(decoder.decode(value.bytes)) as T) : null;
  }

  private pointerKey(botId: string): string {
    return objectKey(this.prefix, "homes", botId, "current.json");
  }

  private manifestKey(botId: string, revision: string): string {
    return objectKey(this.prefix, "homes", botId, "revisions", `${revision}.json`);
  }

  private blobKey(hash: string): string {
    return objectKey(this.prefix, "blobs", "sha256", hash);
  }

  private async withBotWrite<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.botWrites.get(botId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.botWrites.set(botId, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.botWrites.get(botId) === queued) this.botWrites.delete(botId);
    }
  }

  private async waitForBotWrite(botId: string): Promise<void> {
    await (this.botWrites.get(botId) ?? Promise.resolve());
  }
}

async function* walkFiles(root: string, directory: string): AsyncIterable<PortableFile> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      yield* walkFiles(root, full);
      continue;
    }
    if (!info.isFile()) continue;
    const handle = await open(full, "r");
    try {
      yield {
        path: path.relative(root, full).split(path.sep).join("/"),
        content: new Uint8Array(await handle.readFile()),
      };
    } finally {
      await handle.close();
    }
  }
}

function normalizeRelative(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (normalized === ".") return "";
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Path escapes the bot home");
  }
  return normalized;
}

function safeJoin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const contained = resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  if (!contained) throw new Error("Path escapes the bot home");
  return resolved;
}

async function safeWriteTarget(root: string, relative: string): Promise<string> {
  const normalized = normalizeRelative(relative);
  if (!normalized) throw new Error("A home file path is required");
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const segments = normalized.split("/");
  let directory = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    await mkdir(directory).catch((error) => {
      if (!isAlreadyExists(error)) throw error;
    });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Home destination contains a symlink or non-directory");
    }
    const resolved = await realpath(directory);
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Path escapes the bot home");
    }
  }
  const target = safeJoin(resolvedRoot, normalized);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Home destination contains a symlink or non-file");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return target;
}

function withinDirectory(filePath: string, directory: string): boolean {
  return !directory || filePath.startsWith(`${directory}/`);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
