import { describe, expect, it } from "vitest";
import { toHistory } from "./pi-runtime.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";

const model = { api: "openai-completions", provider: "openrouter", id: "m-1" } as never;

const history = [
  { id: "a0", role: "assistant" as const, content: "Welcome!" },
  { id: "u1", role: "user" as const, content: "hi" },
  { id: "a1", role: "assistant" as const, content: "hello" },
  { id: "a2", role: "assistant" as const, content: "and also this" },
  { id: "u2", role: "user" as const, content: "now" },
];

describe("toHistory assistant role (RAKAZO_HISTORY_ASSISTANT_ROLE)", () => {
  it("keeps the legacy pseudo-user format without a model", () => {
    const messages = toHistory(history, "next", null) as Array<{ role: string; content: unknown }>;
    expect(messages.every((m) => m.role === "user")).toBe(true);
    expect(messages[2]!.content).toBe("Assistant: hello");
  });

  it("replays assistant turns as role assistant, merging consecutive ones", () => {
    const messages = toHistory(history, "next", null, model) as Array<
      Record<string, unknown> & { role: string; content: unknown }
    >;
    expect(messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "user"]);
    // A leading assistant message (before any user turn) stays pseudo-user.
    expect(messages[0]!.content).toBe("Assistant: Welcome!");
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "and also this" },
      ],
      provider: "openrouter",
      model: "m-1",
      stopReason: "stop",
      rakazoHistory: true,
      rakazoMessageId: "a1",
      rakazoMessageIds: ["a1", "a2"],
    });
    expect(JSON.stringify(messages)).not.toContain("Assistant: hello");
  });

  it("runtime-context still identifies role:assistant history as historical, not current", () => {
    const messages = toHistory(history, "next", null, model);
    const policy = createRuntimeContextPolicy({
      botId: "b",
      threadId: "t",
      runId: "r",
      prompt: "next",
      instructions: "",
      history,
      tools: [],
      model: { provider: "openrouter", id: "m-1", contextWindow: 100_000, maxTokens: 1000 },
      contextStrategy: "retrieval",
    });
    const current = { role: "user" as const, content: "next", timestamp: 1 };
    const prepared = policy.prepareContext(
      { systemPrompt: "s", messages: [...(messages as never[]), current] },
      {
        id: "m-1",
        provider: "openrouter",
        api: "openai-completions",
        contextWindow: 100_000,
        maxTokens: 1000,
      } as never,
    );
    expect(prepared.messages.at(-1)).toBe(current);
    expect(prepared.messages.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("transcriptMessages", () => {
  it("keeps only assistant/toolResult and maps exposed tool aliases to original names", async () => {
    const { transcriptMessages } = await import("./pi-runtime.js");
    const tools = [{ name: "github_create_issue", label: "github.create-issue" }] as never;
    const out = transcriptMessages(
      [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "github_create_issue", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "c1", toolName: "github_create_issue", content: [] },
      ] as never,
      tools,
    ) as Array<Record<string, unknown>>;
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((out[0]!.content as Array<{ name: string }>)[0]!.name).toBe("github.create-issue");
    expect(out[1]!.toolName).toBe("github.create-issue");
  });
});
