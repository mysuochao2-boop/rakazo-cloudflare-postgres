import {
  ATTACHMENT_MAX_BYTES,
  COMPUTER_ATTACHMENT_MAX_BYTES,
  COMPUTER_FILE_READ_MAX_BYTES,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  classifyComputerReadError,
  readComputerAttachment,
  sanitizeComputerReadDetail,
} from "./computer-attachment-read.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { MAX_SANDBOX_EXPORT_FILE_BYTES } from "./docker-sandbox.js";

const EIGHT_MB = 8 * 1024 * 1024;

/** Stands in for the sandbox supervisor: 413 for any maxBytes above its read cap. */
function supervisorRead(files: Record<string, Uint8Array>) {
  return vi.fn(async (storedPath: string, options: { maxBytes: number }) => {
    if (options.maxBytes > COMPUTER_FILE_READ_MAX_BYTES) {
      throw new Error(
        `sandbox file read failed: 413 {"error":"computer file maxBytes exceeds ${COMPUTER_FILE_READ_MAX_BYTES} bytes"}`,
      );
    }
    const file = files[storedPath];
    if (!file) throw new Error('sandbox file read failed: 404 {"error":"file not found"}');
    if (file.byteLength > options.maxBytes) {
      throw new Error(
        `sandbox file read failed: 413 {"error":"computer file exceeds ${options.maxBytes} bytes"}`,
      );
    }
    return file;
  });
}

const resolveTeam = (requested: string) => resolveBotWorkspacePath("team", "bot-1", requested);

describe("attach_file read limits", () => {
  it("never requests more than the Computer read cap", () => {
    expect(COMPUTER_FILE_READ_MAX_BYTES).toBe(EIGHT_MB);
    expect(COMPUTER_ATTACHMENT_MAX_BYTES).toBe(Math.min(ATTACHMENT_MAX_BYTES, EIGHT_MB));
    expect(COMPUTER_ATTACHMENT_MAX_BYTES).toBeLessThanOrEqual(COMPUTER_FILE_READ_MAX_BYTES);
    expect(MAX_SANDBOX_EXPORT_FILE_BYTES).toBe(COMPUTER_FILE_READ_MAX_BYTES);
  });

  it("reads a small file through a supervisor that rejects maxBytes above 8 MB", async () => {
    const readFile = supervisorRead({
      "bots/bot-1/report.html": new TextEncoder().encode("<p>ok</p>"),
    });
    const result = await readComputerAttachment({
      filePath: "report.html",
      resolvePath: resolveTeam,
      readFile,
    });
    expect(result).toMatchObject({ ok: true, mimeType: "text/html" });
    expect(readFile).toHaveBeenCalledWith("bots/bot-1/report.html", {
      maxBytes: COMPUTER_ATTACHMENT_MAX_BYTES,
    });
  });

  it("reproduces the old failure: a 10 MB request is rejected for any file", async () => {
    const readFile = supervisorRead({ "bots/bot-1/a.txt": new Uint8Array(10) });
    const result = await readComputerAttachment({
      filePath: "a.txt",
      resolvePath: resolveTeam,
      readFile,
      maxBytes: ATTACHMENT_MAX_BYTES,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("reports too large with the limit when the file itself exceeds it", async () => {
    const readFile = supervisorRead({ "bots/bot-1/big.pdf": new Uint8Array(EIGHT_MB + 1) });
    const result = await readComputerAttachment({
      filePath: "big.pdf",
      resolvePath: resolveTeam,
      readFile,
    });
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      error: "file is too large to attach (limit 8 MB)",
    });
  });

  it("enforces the cap even when a provider returns more bytes than asked", async () => {
    const result = await readComputerAttachment({
      filePath: "big.png",
      resolvePath: (p) => p,
      readFile: async () => new Uint8Array(COMPUTER_ATTACHMENT_MAX_BYTES + 1),
    });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });
});

describe("attach_file type check", () => {
  it("rejects .svg before reading, with supported types and what to do instead", async () => {
    const readFile = vi.fn();
    const result = await readComputerAttachment({
      filePath: "pelican_bike.svg",
      resolvePath: resolveTeam,
      readFile,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_type");
    expect(result.error).toContain('unsupported attachment type ".svg"');
    expect(result.error).toContain(
      "supported: .jpg, .jpeg, .png, .webp, .gif, .pdf, .txt, .md, .markdown, .csv, .html, .htm, .json (max 8 MB)",
    );
    expect(result.error).toContain("```svg");
    expect(result.error).toContain("convert it to PNG");
  });

  it("rejects other unsupported types without the SVG hint", async () => {
    const zip = await readComputerAttachment({
      filePath: "out/a.ZIP",
      resolvePath: resolveTeam,
      readFile: vi.fn(),
    });
    expect(zip).toMatchObject({ ok: false, reason: "unsupported_type" });
    if (!zip.ok) {
      expect(zip.error).toMatch(/^unsupported attachment type "\.zip"; supported: /);
      expect(zip.error).not.toContain("SVG");
    }
    const bare = await readComputerAttachment({
      filePath: "Makefile",
      resolvePath: resolveTeam,
      readFile: vi.fn(),
    });
    if (!bare.ok) expect(bare.error).toContain("(no file extension)");
  });

  it("requires a path", async () => {
    await expect(
      readComputerAttachment({ filePath: " ", resolvePath: resolveTeam, readFile: vi.fn() }),
    ).resolves.toEqual({ ok: false, reason: "missing_path", error: "path is required" });
  });
});

describe("attach_file read failures", () => {
  it("separates not found from the other causes", async () => {
    const result = await readComputerAttachment({
      filePath: "missing.txt",
      resolvePath: resolveTeam,
      readFile: supervisorRead({}),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    if (!result.ok) expect(result.error).toMatch(/^file not found/);
  });

  it("reports an escaping path as invalid without calling the Computer", async () => {
    const readFile = vi.fn();
    const result = await readComputerAttachment({
      filePath: "../other-bot/secret.txt",
      resolvePath: resolveTeam,
      readFile,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: "path_invalid" });
  });

  it("maps provider error shapes to a specific reason", () => {
    const limit = { maxBytes: EIGHT_MB };
    const errno = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(classifyComputerReadError(errno("ENOENT", "ENOENT: no such file"), limit).reason).toBe(
      "not_found",
    );
    expect(
      classifyComputerReadError(errno("EISDIR", "EISDIR: illegal operation"), limit).reason,
    ).toBe("path_invalid");
    expect(
      classifyComputerReadError(new Error("Path escapes the computer workspace"), limit).reason,
    ).toBe("path_invalid");
    expect(
      classifyComputerReadError(new Error("computer file exceeds 8388608 bytes"), limit),
    ).toEqual({
      reason: "too_large",
      message: "file is too large to attach (limit 8 MB)",
    });
    const denied = classifyComputerReadError(
      new Error(
        "sandbox file read failed: 404 PermissionError: [Errno 13] Permission denied: '/home/rakazo/bots/b/x.txt'",
      ),
      limit,
    );
    expect(denied.reason).toBe("read_failed");
    expect(denied.message).toContain("permission denied");
    expect(denied.message).not.toContain("/home/rakazo");
    const other = classifyComputerReadError(new Error("sandbox bot-9 is not running"), limit);
    expect(other).toEqual({
      reason: "read_failed",
      message: "could not read file: sandbox bot-9 is not running",
    });
  });

  it("strips secrets, bearer tokens and absolute paths from raw detail", () => {
    const detail = sanitizeComputerReadDetail(
      "failed for /Users/alice/Private Notes/x.txt with Bearer abc.def token sk-live-123",
      ["sk-live-123"],
    );
    expect(detail).not.toContain("alice");
    expect(detail).not.toContain("abc.def");
    expect(detail).not.toContain("sk-live-123");
    expect(detail).toContain("<path>");
    expect(sanitizeComputerReadDetail("x".repeat(500)).length).toBeLessThanOrEqual(161);
  });
});

describe("attach_file tool description", () => {
  it("lists the supported types and the size limit", () => {
    const description =
      builtinAgentTools.find((tool) => tool.name === "attach_file")?.description ?? "";
    expect(description).toContain(".png");
    expect(description).toContain(".pdf");
    expect(description).toContain(".json");
    expect(description).toContain("max 8 MB");
    expect(description).toContain(".svg");
  });
});
