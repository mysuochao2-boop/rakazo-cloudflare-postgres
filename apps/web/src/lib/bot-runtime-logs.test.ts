import type { BotRuntimeLogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRunCards,
  filterLogEntries,
  formatDuration,
  formatLogLine,
  mergeLogEntries,
  shouldRefreshOverview,
} from "./bot-runtime-logs";

function entry(seq: number, overrides: Partial<BotRuntimeLogEntry> = {}): BotRuntimeLogEntry {
  return {
    seq,
    ts: new Date(Date.UTC(2026, 9, 17, 7, 0, 0, seq * 100)).toISOString(),
    runId: "run-1",
    threadId: "thread-1",
    lane: "interactive",
    level: "info",
    code: "tool.end",
    tool: null,
    ok: null,
    ms: null,
    summary: null,
    ...overrides,
  };
}

describe("bot runtime log helpers", () => {
  it("merges by seq without duplicates and keeps the newest lines", () => {
    const merged = mergeLogEntries([entry(1), entry(3)], [entry(2), entry(3)], 2);
    expect(merged.map((line) => line.seq)).toEqual([2, 3]);
  });

  it("filters by lane, run, and problems", () => {
    const lines = [
      entry(1),
      entry(2, { lane: null, runId: "run-bg" }),
      entry(3, { ok: false }),
      entry(4, { level: "error", runId: "run-2" }),
    ];
    const lanes = new Map([["run-bg", "background"]]);
    expect(
      filterLogEntries(lines, { lane: "background", errorsOnly: false, runId: null }, lanes).map(
        (line) => line.seq,
      ),
    ).toEqual([2]);
    expect(
      filterLogEntries(lines, { lane: "all", errorsOnly: true, runId: null }).map(
        (line) => line.seq,
      ),
    ).toEqual([3, 4]);
    expect(
      filterLogEntries(lines, { lane: "all", errorsOnly: false, runId: "run-2" }).map(
        (line) => line.seq,
      ),
    ).toEqual([4]);
  });

  it("formats lines and durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1_250)).toBe("1.3s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatLogLine(entry(1, { tool: "computer", ok: false, ms: 1_500 }))).toBe(
      "tool.end · computer · failed · 1.5s",
    );
  });

  it("builds run cards with milestones and tool counts", () => {
    const lines = [
      entry(1, { code: "send.enqueued" }),
      entry(5, { code: "runtime.accepted" }),
      entry(12, { code: "model.first_token" }),
      entry(13, { code: "tool.end", tool: "shell", ok: true }),
      entry(14, { code: "tool.end", tool: "browser", ok: false }),
      entry(20, { code: "model.stream_end" }),
    ];
    const [card] = buildRunCards(lines, [
      {
        id: "run-1",
        lane: "interactive",
        trigger: "user",
        status: "completed",
        error: null,
        createdAt: lines[0]!.ts,
        startedAt: lines[1]!.ts,
        completedAt: lines[5]!.ts,
      },
    ]);
    expect(card).toMatchObject({
      runId: "run-1",
      status: "completed",
      toolCalls: 2,
      toolFailures: 1,
      problems: 1,
    });
    expect(card!.milestones).toEqual([
      { label: "queued", offsetMs: 0 },
      { label: "accepted", offsetMs: 400 },
      { label: "first token", offsetMs: 1_100 },
      { label: "done", offsetMs: 1_900 },
    ]);
  });

  it("refreshes the overview on lifecycle lines only", () => {
    expect(shouldRefreshOverview(entry(1, { code: "run.final_persist" }))).toBe(true);
    expect(shouldRefreshOverview(entry(1, { code: "tool.start" }))).toBe(false);
  });
});
