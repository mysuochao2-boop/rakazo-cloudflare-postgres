import { afterEach, describe, expect, it, vi } from "vitest";
import {
  botLiveLogsEnabled,
  emitRuntimeLog,
  runtimeLogFromTiming,
  setRuntimeLogTap,
  summarizeAgentLogFields,
} from "./runtime-log.js";

afterEach(() => setRuntimeLogTap(undefined));

describe("runtime log tap", () => {
  it("is off unless RAKAZO_BOT_LIVE_LOGS is set", () => {
    expect(botLiveLogsEnabled({})).toBe(false);
    expect(botLiveLogsEnabled({ RAKAZO_BOT_LIVE_LOGS: "0" })).toBe(false);
    expect(botLiveLogsEnabled({ RAKAZO_BOT_LIVE_LOGS: "1" })).toBe(true);
    expect(botLiveLogsEnabled({ RAKAZO_BOT_LIVE_LOGS: " On " })).toBe(true);
  });

  it("is a no-op without a tap and never throws from a failing tap", () => {
    expect(() => emitRuntimeLog({ code: "tool.end" })).not.toThrow();
    const tap = vi.fn(() => {
      throw new Error("boom");
    });
    setRuntimeLogTap(tap);
    expect(() => emitRuntimeLog({ code: "tool.end" })).not.toThrow();
    expect(tap).toHaveBeenCalledOnce();
  });

  it("keeps only metadata from timing fields", () => {
    const entry = runtimeLogFromTiming("tool.end", {
      runId: "run-1",
      threadId: "thread-1",
      tool: "computer",
      ok: false,
      ms: 412,
      args: { command: "cat ~/.ssh/id_rsa" },
      prompt: "secret prompt",
    });
    expect(entry).toEqual({
      code: "tool.end",
      level: "warn",
      runId: "run-1",
      threadId: "thread-1",
      lane: null,
      ms: 412,
      tool: "computer",
      ok: false,
      summary: null,
    });
    expect(runtimeLogFromTiming("edge.container_ready", { cold: true, runId: "r" }).summary).toBe(
      "cold=true",
    );
  });

  it("summarizes agent logs without free text", () => {
    expect(
      summarizeAgentLogFields({
        runId: "run-1",
        kind: "steps",
        mode: "observe",
        steps: 61,
        limit: 60,
        error: "provider said: Bearer abc",
        name: "a long tool name with spaces",
      }),
    ).toBe("kind=steps mode=observe steps=61 limit=60");
  });
});
