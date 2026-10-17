import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentHistoryTranscript } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { structuredHistoryFallbackStream, toHistory } from "./pi-runtime.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import {
  buildStructuredHistory,
  flattenStructuredHistory,
  looksLikeHistoryShapeError,
  MISSING_RESULT_TEXT,
  normalizedToolCallId,
  replayTranscript,
} from "./structured-history.js";

const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-x" };
const toolNames = new Map([
  ["shell", "shell"],
  ["read_file", "read_file"],
  ["github.create-issue", "github_create_issue"],
]);

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const result = (id: string, name: string, text: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  ...extra,
});
const assistant = (content: unknown[], meta: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-x",
  stopReason: "toolUse",
  ...meta,
});

function transcript(
  runId: string,
  messages: unknown[],
  meta: Partial<AgentHistoryTranscript> = {},
) {
  return {
    runId,
    provider: "anthropic",
    modelId: "claude-x",
    api: "anthropic-messages",
    messages,
    ...meta,
  };
}

describe("replayTranscript", () => {
  it("pairs results, normalizes ids, synthesizes missing results and drops orphans/duplicates", () => {
    const out = replayTranscript(
      transcript("run-1", [
        result("ghost", "shell", "orphan before any call"),
        assistant([
          { type: "text", text: "Checking" },
          call("toolu_A|weird/id", "shell", { command: "ls" }),
          call("toolu_B", "read_file", { path: "a" }),
        ]),
        result("toolu_A|weird/id", "shell", "file-a"),
        result("toolu_A|weird/id", "shell", "duplicate"),
        result("unknown", "shell", "orphan"),
        assistant([{ type: "text", text: "Done" }], { stopReason: "stop" }),
      ]),
      { model, toolNames, full: true },
    );
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);
    const calls = (out[0]!.content as Array<Record<string, string>>).filter(
      (p) => p.type === "toolCall",
    );
    expect(calls.map((c) => c.id)).toEqual([
      normalizedToolCallId("run-1", "toolu_A|weird/id"),
      normalizedToolCallId("run-1", "toolu_B"),
    ]);
    for (const c of calls) {
      expect(c.id).toMatch(/^rk_[A-Za-z0-9_-]+$/);
      expect(c.id.length).toBeLessThanOrEqual(64);
    }
    expect(out[1]).toMatchObject({ toolCallId: calls[0]!.id, content: [{ text: "file-a" }] });
    expect(out[2]).toMatchObject({
      toolCallId: calls[1]!.id,
      isError: true,
      content: [{ text: MISSING_RESULT_TEXT }],
    });
    expect(JSON.stringify(out)).not.toContain("orphan");
    expect(JSON.stringify(out)).not.toContain("duplicate");
  });

  it("keeps thinking only for the same provider+model", () => {
    const messages = [
      assistant(
        [
          { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
          { type: "text", text: "ok" },
          { ...call("c1", "shell"), thoughtSignature: "ts" },
        ],
        {},
      ),
      result("c1", "shell", "out"),
    ];
    const same = replayTranscript(transcript("r", messages), { model, toolNames, full: true });
    expect(JSON.stringify(same)).toContain('"thinking":"plan"');
    expect(JSON.stringify(same)).toContain('"thoughtSignature":"ts"');
    const other = replayTranscript(transcript("r", messages), {
      model: { ...model, id: "claude-y" },
      toolNames,
      full: true,
    });
    expect(JSON.stringify(other)).not.toContain("thinking");
    expect(JSON.stringify(other)).not.toContain("thoughtSignature");
    // Cross-model messages keep their original attribution so pi-ai normalizes them.
    expect(other[0]).toMatchObject({ model: "claude-x" });
  });

  it("degrades calls to tools missing from the current toolset into assistant text", () => {
    const out = replayTranscript(
      transcript("r", [
        assistant([
          call("c1", "slack.post", { text: "hi" }),
          call("c2", "shell", { command: "pwd" }),
        ]),
        result("c1", "slack.post", "posted ts=1"),
        result("c2", "shell", "/home"),
      ]),
      { model, toolNames, full: true },
    );
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    const text = JSON.stringify(out[0]);
    expect(text).toContain("[earlier tool call: slack.post(");
    expect(text).toContain("posted ts=1");
    expect(text).not.toContain('"name":"slack.post"');
  });

  it("maps original tool names to the current exposed alias", () => {
    const out = replayTranscript(
      transcript("r", [
        assistant([call("c1", "github.create-issue")]),
        result("c1", "github.create-issue", "#1"),
      ]),
      { model, toolNames, full: true },
    );
    expect((out[0]!.content as Array<Record<string, string>>)[0]!.name).toBe("github_create_issue");
    expect(out[1]!.toolName).toBe("github_create_issue");
  });

  it("summarizes older runs to one line and truncates large arguments", () => {
    const out = replayTranscript(
      transcript("r", [
        assistant([call("c1", "shell", { command: "x".repeat(2000) })]),
        result("c1", "shell", `line1\nline2 ${"y".repeat(5000)}`),
      ]),
      { model, toolNames, full: false },
    );
    const resultText = (out[1]!.content as Array<{ text: string }>)[0]!.text;
    expect(
      resultText.startsWith("[shell result from an earlier turn, summarized: line1 line2"),
    ).toBe(true);
    expect(resultText.length).toBeLessThan(300);
    expect(JSON.stringify(out[0]).length).toBeLessThan(1000);
  });

  it("never replays images", () => {
    const out = replayTranscript(
      transcript("r", [
        assistant([call("c1", "shell")]),
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "shell",
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        },
      ]),
      { model, toolNames, full: true },
    );
    expect(JSON.stringify(out)).not.toContain("AAAA");
    expect(JSON.stringify(out)).toContain("[screenshot omitted]");
  });
});

describe("buildStructuredHistory", () => {
  const user = (entry: { content: string }) => ({
    role: "user",
    content: entry.content,
    timestamp: 0,
  });
  const text = (entry: { content: string }) => ({
    role: "assistant",
    content: [{ type: "text", text: entry.content }],
  });

  it("replays only transcript-backed runs, keeps the last 3 runs full, and collapses repeat entries", () => {
    const runs = ["r1", "r2", "r3", "r4"];
    const entries = [
      { id: "u0", role: "user" as const, content: "start" },
      ...runs.flatMap((runId, index) => [
        { id: `a${index}`, role: "assistant" as const, content: `reply ${index}`, runId },
        { id: `u${index + 1}`, role: "user" as const, content: `next ${index}` },
      ]),
      {
        id: "a-r4-second",
        role: "assistant" as const,
        content: "second message of r4",
        runId: "r4",
      },
      { id: "plain", role: "assistant" as const, content: "no transcript", runId: "r-none" },
    ];
    const transcripts = runs.map((runId) =>
      transcript(runId, [
        assistant([call(`${runId}-c`, "shell", { command: runId })]),
        result(`${runId}-c`, "shell", `full output of ${runId}`),
        assistant([{ type: "text", text: `reply from ${runId}` }], { stopReason: "stop" }),
      ]),
    );
    const { messages, stats } = buildStructuredHistory(entries, {
      model,
      transcripts,
      toolNames,
      userMessage: user,
      assistantText: text,
    });
    const json = JSON.stringify(messages);
    expect(stats.runsReplayed).toBe(4);
    expect(json).not.toContain(`"full output of r1"`);
    expect(json).toContain("[shell result from an earlier turn, summarized: full output of r1]");
    for (const runId of ["r2", "r3", "r4"]) expect(json).toContain(`"full output of ${runId}"`);
    expect(json).not.toContain("second message of r4");
    expect(json).toContain("no transcript");
    expect(
      (messages as Array<Record<string, unknown>>).every((m) => m.rakazoStructuredHistory),
    ).toBe(true);
  });

  it("appends the visible reply when a paused run ends on a tool result", () => {
    const { messages } = buildStructuredHistory(
      [
        { id: "u", role: "user", content: "send it" },
        { id: "a", role: "assistant", content: "Waiting for your approval.", runId: "r" },
      ],
      {
        model,
        transcripts: [transcript("r", [assistant([call("c", "shell")])])],
        toolNames,
        userMessage: user,
        assistantText: text,
      },
    );
    expect((messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});

describe("toHistory structured integration", () => {
  it("produces context that runtime-context accepts (paired groups, current prompt last)", () => {
    const history = [
      { id: "u1", role: "user" as const, content: "list files" },
      { id: "a1", role: "assistant" as const, content: "Here they are", runId: "r1" },
    ];
    const messages = toHistory(history, "again", null, model, {
      transcripts: [
        transcript("r1", [
          assistant([call("c1", "shell", { command: "ls" })]),
          result("c1", "shell", "a b c"),
          assistant([{ type: "text", text: "Here they are" }], { stopReason: "stop" }),
        ]),
      ],
      toolNames,
    });
    const current = { role: "user" as const, content: "again", timestamp: 1 };
    for (const strategy of ["retrieval", "snapshots", "current"] as const) {
      const policy = createRuntimeContextPolicy({
        botId: "b",
        threadId: "t",
        runId: `r-${strategy}`,
        prompt: "again",
        instructions: "",
        history,
        tools: [],
        model: { provider: "anthropic", id: "claude-x", contextWindow: 200_000, maxTokens: 1000 },
        contextStrategy: strategy,
      });
      const prepared = policy.prepareContext(
        { systemPrompt: "s", messages: [...(messages as never[]), current] },
        { ...model, contextWindow: 200_000, maxTokens: 1000 } as never,
      );
      expect(prepared.messages.at(-1)).toBe(current);
      expect(prepared.messages.map((m) => m.role)).toContain("toolResult");
    }
  });
});

describe("structured history provider fallback", () => {
  const failure = (errorMessage: string) => ({
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages" as never,
    provider: "anthropic",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage,
    timestamp: 0,
  });
  const success = {
    ...failure(""),
    stopReason: "stop" as const,
    errorMessage: undefined,
    content: [{ type: "text" as const, text: "ok" }],
  };
  const streamOf = (kind: "fail" | "ok", message = "400 invalid_request_error: tool_use ids") => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      if (kind === "fail") {
        const error = failure(message);
        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
      } else {
        stream.push({ type: "done", reason: "stop", message: success });
        stream.end(success);
      }
    });
    return stream;
  };
  const structuredMsg = { role: "assistant", content: [], rakazoStructuredHistory: true };
  const flatMsg = { role: "user", content: "Assistant: earlier", timestamp: 0 };
  const live = { role: "user", content: "now", timestamp: 1 };

  it("retries once with flat history on a history-shaped 400 and stays flat afterwards", async () => {
    const state = { active: true, flat: [flatMsg] as never[], runId: "r" };
    const seen: unknown[][] = [];
    const out = structuredHistoryFallbackStream(
      state,
      { systemPrompt: "s", messages: [structuredMsg, live] as never },
      (ctx) => {
        seen.push(ctx.messages);
        return streamOf(seen.length === 1 ? "fail" : "ok");
      },
    );
    const events = [];
    for await (const event of out) events.push(event.type);
    expect(events).toEqual(["done"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([flatMsg, live]);
    expect(state.active).toBe(false);
    const next: unknown[][] = [];
    const again = structuredHistoryFallbackStream(
      state,
      { systemPrompt: "s", messages: [structuredMsg, live] as never },
      (ctx) => {
        next.push(ctx.messages);
        return streamOf("ok");
      },
    );
    for await (const _ of again) void _;
    expect(next[0]).toEqual([flatMsg, live]);
  });

  it("passes through unrelated errors without retrying", async () => {
    const state = { active: true, flat: [flatMsg] as never[], runId: "r" };
    let calls = 0;
    const out = structuredHistoryFallbackStream(
      state,
      { systemPrompt: "s", messages: [structuredMsg, live] as never },
      () => {
        calls += 1;
        return streamOf("fail", "503 overloaded");
      },
    );
    const events = [];
    for await (const event of out) events.push(event.type);
    expect(events).toEqual(["error"]);
    expect(calls).toBe(1);
    expect(state.active).toBe(true);
  });

  it("helpers", () => {
    expect(looksLikeHistoryShapeError("400 Bad Request")).toBe(true);
    expect(looksLikeHistoryShapeError("Orphaned tool result in context")).toBe(true);
    expect(looksLikeHistoryShapeError("rate limited")).toBe(false);
    expect(flattenStructuredHistory([structuredMsg, live], [flatMsg])).toEqual([flatMsg, live]);
  });
});
