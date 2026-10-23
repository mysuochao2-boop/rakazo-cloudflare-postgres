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
  /**
   * Present only in version 2 manifests: the file's bytes live at `offset` inside the pack
   * object `packs/sha256/<pack>` instead of their own `blobs/sha256/<hash>` object.
   */
  pack?: string;
  offset?: number;
}

interface HomeManifest {
  /** 1: every file is its own blob. 2: some files are slices of pack objects. */
  version: 1 | 2;
  botId: string;
  revision: string;
  files: HomeFile[];
}

export interface R2AgentHomeStoreOptions {
  /**
   * Bundle new small files into pack objects (manifest v2) instead of one PUT per file.
   * Readers accept both formats; only writers need this flag. Rolling back to a build that
   * predates manifest v2 cannot read packed revisions, so keep it off until this build is
   * the oldest one that may restore a home.
   */
  packSmallFiles?: boolean;
  /** Files up to this size are packed. Default 256 KiB. */
  packFileMaxBytes?: number;
  /** A pack is flushed once it reaches this size. Default 8 MiB. */
  packTargetBytes?: number;
  /** Concurrent object PUTs per commit. Default 8. */
  uploadConcurrency?: number;
}

const DEFAULT_PACK_FILE_MAX_BYTES = 256 * 1024;
const DEFAULT_PACK_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_CONCURRENCY = 8;
const PACK_CACHE_ENTRIES = 4;

/** Reads `RAKAZO_HOME_PACK_SMALL_FILES` (and friends) for the R2 home store. */
export function r2HomeStoreOptionsFromEnv(env: NodeJS.ProcessEnv): R2AgentHomeStoreOptions {
  const flag = env.RAKAZO_HOME_PACK_SMALL_FILES?.trim().toLowerCase();
  return {
    packSmallFiles: flag === "1" || flag === "true",
    ...positiveIntegerOption("packFileMaxBytes", env.RAKAZO_HOME_PACK_FILE_MAX_BYTES),
    ...positiveIntegerOption("packTargetBytes", env.RAKAZO_HOME_PACK_TARGET_BYTES),
    ...positiveIntegerOption("uploadConcurrency", env.RAKAZO_HOME_UPLOAD_CONCURRENCY),
  };
}

function positiveIntegerOption<K extends keyof R2AgentHomeStoreOptions>(
  key: K,
  raw: string | undefined,
): Partial<Record<K, number>> {
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0
    ? ({ [key]: value } as Partial<Record<K, number>>)
    : {};
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
    private readonly options: R2AgentHomeStoreOptions = {},
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
    const reader = this.contentReader();
    await Promise.all(
      manifest.files.map(async (file) => {
        const target = await safeWriteTarget(dest, file.path);
        const bytes = await reader(file);
        const handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(bytes);
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
      // Content addressed blobs and packs are immutable and never collected, so anything the
      // current revision references already exists: skip re-uploading unchanged files.
      const previous = await this.currentManifest(botId).catch(() => null);
      const known = new Map<string, HomeFile>();
      for (const file of previous?.files ?? []) {
        if (!known.has(file.hash)) known.set(file.hash, file);
      }
      const packSmall = this.options.packSmallFiles === true;
      const packFileMax = this.options.packFileMaxBytes ?? DEFAULT_PACK_FILE_MAX_BYTES;
      const packTarget = this.options.packTargetBytes ?? DEFAULT_PACK_TARGET_BYTES;
      const uploads = boundedQueue(this.options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY);
      const files: HomeFile[] = [];
      let pending: { chunks: Uint8Array[]; bytes: number; entries: HomeFile[] } = {
        chunks: [],
        bytes: 0,
        entries: [],
      };
      const pendingByHash = new Map<string, HomeFile>();
      const flushPack = async () => {
        if (pending.entries.length === 0) return;
        const pack = pending;
        pending = { chunks: [], bytes: 0, entries: [] };
        pendingByHash.clear();
        const bytes = Buffer.concat(pack.chunks);
        const packHash = createHash("sha256").update(bytes).digest("hex");
        for (const entry of pack.entries) {
          entry.pack = packHash;
          if (!known.has(entry.hash)) known.set(entry.hash, entry);
        }
        await uploads.add(() =>
          this.objects.put(this.packKey(packHash), {
            bytes: new Uint8Array(bytes),
            contentType: "application/octet-stream",
          }),
        );
      };
      for await (const file of walkFiles(src, src)) {
        const hash = createHash("sha256").update(file.content).digest("hex");
        const size = file.content.byteLength;
        const reused = known.get(hash);
        if (reused) {
          files.push({
            path: file.path,
            hash,
            size,
            ...(reused.pack ? { pack: reused.pack, offset: reused.offset } : {}),
          });
          continue;
        }
        const inOpenPack = pendingByHash.get(hash);
        if (inOpenPack) {
          // The duplicate gets its pack id when the open pack flushes.
          const entry: HomeFile = { path: file.path, hash, size, offset: inOpenPack.offset };
          pending.entries.push(entry);
          files.push(entry);
          continue;
        }
        if (packSmall && size <= packFileMax) {
          const entry: HomeFile = { path: file.path, hash, size, offset: pending.bytes };
          pending.chunks.push(file.content);
          pending.bytes += size;
          pending.entries.push(entry);
          pendingByHash.set(hash, entry);
          files.push(entry);
          if (pending.bytes >= packTarget) await flushPack();
          continue;
        }
        const entry: HomeFile = { path: file.path, hash, size };
        known.set(hash, entry);
        files.push(entry);
        const content = file.content;
        await uploads.add(() =>
          this.objects.put(this.blobKey(hash), {
            bytes: content,
            contentType: "application/octet-stream",
          }),
        );
      }
      await flushPack();
      await uploads.drain();
      files.sort((left, right) => left.path.localeCompare(right.path));
      const version = files.some((file) => file.pack !== undefined) ? 2 : 1;
      const manifest: HomeManifest = { version, botId, revision, files };
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
    const reader = this.contentReader();
    for (const file of manifest.files) {
      const bytes = await reader(file);
      const target = await safeWriteTarget(dest, file.path);
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
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
    const reader = this.contentReader();
    for (const file of manifest.files) {
      if (!withinDirectory(file.path, directory)) continue;
      const relative = directory ? file.path.slice(directory.length + 1) : file.path;
      if (options.skipHidden && relative.split("/")[0]?.startsWith(".")) continue;
      yield { path: relative, content: await reader(file) };
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
    return decoder.decode(await this.contentReader()(file));
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

  /**
   * Reads one manifest entry from its blob (v1) or its pack slice (v2). A small LRU keeps the
   * last few packs so a checkout of one revision fetches each pack about once.
   */
  private contentReader(): (file: HomeFile) => Promise<Uint8Array> {
    const packs = new Map<string, Promise<Uint8Array>>();
    const loadPack = (pack: string) => {
      const cached = packs.get(pack);
      if (cached) {
        packs.delete(pack);
        packs.set(pack, cached);
        return cached;
      }
      const loading = this.objects.get(this.packKey(pack)).then((value) => {
        if (!value) throw new Error(`Agent home pack is missing: ${pack}`);
        return value.bytes;
      });
      loading.catch(() => packs.delete(pack));
      packs.set(pack, loading);
      while (packs.size > PACK_CACHE_ENTRIES) packs.delete(packs.keys().next().value!);
      return loading;
    };
    return async (file) => {
      if (file.pack === undefined) {
        const value = await this.objects.get(this.blobKey(file.hash));
        if (!value) throw new Error(`Agent home blob is missing: ${file.hash}`);
        return value.bytes;
      }
      const pack = await loadPack(file.pack);
      const offset = file.offset ?? -1;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + file.size > pack.byteLength) {
        throw new Error(`Agent home pack entry is out of range: ${file.path}`);
      }
      const bytes = pack.slice(offset, offset + file.size);
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash) {
        throw new Error(`Agent home pack entry is corrupt: ${file.path}`);
      }
      return bytes;
    };
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

  private packKey(hash: string): string {
    return objectKey(this.prefix, "packs", "sha256", hash);
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

/** Runs at most `limit` tasks at once; `add` waits for a free slot, `drain` for all. */
function boundedQueue(limit: number) {
  const running = new Set<Promise<void>>();
  let failure: unknown;
  return {
    async add(task: () => Promise<void>) {
      if (failure) throw failure;
      while (running.size >= Math.max(1, limit)) await Promise.race(running);
      if (failure) throw failure;
      const promise: Promise<void> = task()
        .catch((error: unknown) => {
          failure ??= error;
        })
        .finally(() => running.delete(promise));
      running.add(promise);
    },
    async drain() {
      await Promise.all(running);
      if (failure) throw failure;
    },
  };
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
