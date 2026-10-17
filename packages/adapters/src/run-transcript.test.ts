import { describe, expect, it, vi } from "vitest";
import { sanitizeTranscript } from "./run-transcript.js";
import { recordRunTranscript } from "./run-transcript-store.js";

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-x",
  stopReason: "toolUse",
  usage: { input: 10 },
  timestamp: 1,
  ...extra,
});

describe("sanitizeTranscript", () => {
  it("keeps assistant/toolResult only, strips images, redacts secrets and drops usage/details", () => {
    const result = sanitizeTranscript(
      [
        { role: "user", content: "prompt", timestamp: 0 },
        assistant([
          { type: "thinking", thinking: "plan with hunter2", thinkingSignature: "sig" },
          { type: "text", text: "Using token sk-or-v1-abcdef123" },
          {
            type: "toolCall",
            id: "toolu_1",
            name: "shell",
            arguments: { command: "curl -H 'Authorization: Bearer abc.def' https://x" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "toolu_1",
          toolName: "shell",
          content: [
            { type: "text", text: "password=hunter2 ok" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          details: { raw: "big" },
          isError: false,
          timestamp: 2,
        },
      ],
      ["hunter2"],
    );
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    const json = JSON.stringify(result.messages);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("sk-or-v1-abcdef123");
    expect(json).not.toContain("abc.def");
    expect(json).not.toContain("AAAA");
    expect(json).not.toContain("usage");
    expect(json).not.toContain("details");
    expect(json).toContain("[screenshot omitted: image/png]");
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
    });
    expect(result.bytes).toBe(Buffer.byteLength(json));
  });

  it("clips long tool results and enforces the byte cap", () => {
    const long = "x".repeat(50_000);
    const messages = [
      assistant([{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read_file",
        content: [{ type: "text", text: long }],
      },
    ];
    const normal = sanitizeTranscript(messages);
    expect(JSON.stringify(normal.messages).length).toBeLessThan(13_000);
    const tight = sanitizeTranscript(messages, [], { maxBytes: 3_000 });
    expect(tight.truncated).toBe(true);
    expect(tight.bytes).toBeLessThanOrEqual(3_000);
  });
});

describe("recordRunTranscript", () => {
  it("upserts one sanitized row per run and never throws", async () => {
    const upsert = vi.fn(async () => ({}));
    await recordRunTranscript({ runTranscript: { upsert } } as never, {
      runId: "r1",
      threadId: "t1",
      botId: "b1",
      transcript: {
        provider: "anthropic",
        modelId: "claude-x",
        messages: [assistant([{ type: "text", text: "done" }])],
      },
      secrets: [],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: "r1" },
        create: expect.objectContaining({ runId: "r1", threadId: "t1", formatVersion: 1 }),
      }),
    );
    const failing = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(
      recordRunTranscript({ runTranscript: { upsert: failing } } as never, {
        runId: "r2",
        threadId: "t1",
        botId: "b1",
        transcript: {
          provider: "p",
          modelId: "m",
          messages: [assistant([{ type: "text", text: "x" }])],
        },
        secrets: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("skips empty transcripts", async () => {
    const upsert = vi.fn();
    await recordRunTranscript({ runTranscript: { upsert } } as never, {
      runId: "r3",
      threadId: "t",
      botId: "b",
      transcript: { provider: "p", modelId: "m", messages: [{ role: "user", content: "x" }] },
      secrets: [],
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
