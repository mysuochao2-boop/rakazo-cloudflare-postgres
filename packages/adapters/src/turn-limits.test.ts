import { turnLimitsFor } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveToolCallLimit, ToolBatchStats, TurnLimitObserver } from "./turn-limits.js";

describe("turn limits", () => {
  afterEach(() => vi.useRealTimers());

  it("defaults: off, 60 interactive steps, 200 background steps / 2h, no interactive wall", () => {
    expect(turnLimitsFor("interactive", {})).toEqual({ mode: "off", maxSteps: 60, maxWallMs: 0 });
    expect(turnLimitsFor("background", { RAKAZO_TURN_LIMITS: "enforce" })).toEqual({
      mode: "enforce",
      maxSteps: 200,
      maxWallMs: 7_200_000,
    });
    expect(turnLimitsFor("interactive", { RAKAZO_TURN_LIMITS: "bogus" }).mode).toBe("off");
  });

  it("task overrides win over env defaults", () => {
    expect(
      turnLimitsFor(
        "background",
        { RAKAZO_TURN_LIMITS: "observe" },
        { maxSteps: 12, maxWallMs: 1000 },
      ),
    ).toEqual({ mode: "observe", maxSteps: 12, maxWallMs: 1000 });
  });

  it("only enforce mode changes the tool-call fuse", () => {
    expect(effectiveToolCallLimit(0, { mode: "observe", maxSteps: 60, maxWallMs: 0 })).toBe(0);
    expect(effectiveToolCallLimit(0, { mode: "enforce", maxSteps: 60, maxWallMs: 0 })).toBe(60);
    expect(effectiveToolCallLimit(10, { mode: "enforce", maxSteps: 60, maxWallMs: 0 })).toBe(10);
    expect(effectiveToolCallLimit(0, { mode: "enforce", maxSteps: 0, maxWallMs: 0 })).toBe(0);
  });

  it("observer reports the first step crossing once and the wall clock in observe mode without enforcing", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const enforce = vi.fn();
    const observer = new TurnLimitObserver(
      { mode: "observe", maxSteps: 2, maxWallMs: 1000 },
      "run-1",
      "interactive",
      report,
    );
    observer.startWallClock(() => 3, enforce);
    observer.onStep(1);
    observer.onStep(2);
    observer.onStep(3);
    observer.onStep(4);
    vi.advanceTimersByTime(1000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]![0]).toMatchObject({ kind: "steps", mode: "observe", steps: 3 });
    expect(report.mock.calls[1]![0]).toMatchObject({ kind: "wall", mode: "observe" });
    expect(enforce).not.toHaveBeenCalled();
    expect(observer.wallExceeded).toBe(false);
  });

  it("observer enforces the wall clock in enforce mode", () => {
    vi.useFakeTimers();
    const enforce = vi.fn();
    const observer = new TurnLimitObserver(
      { mode: "enforce", maxSteps: 0, maxWallMs: 500 },
      "run-2",
      "background",
      () => undefined,
    );
    observer.startWallClock(() => 0, enforce);
    vi.advanceTimersByTime(499);
    expect(enforce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(observer.wallExceeded).toBe(true);
  });

  it("observer stop() cancels the wall clock", () => {
    vi.useFakeTimers();
    const enforce = vi.fn();
    const observer = new TurnLimitObserver(
      { mode: "enforce", maxSteps: 0, maxWallMs: 500 },
      "run-3",
      "interactive",
      () => undefined,
    );
    observer.startWallClock(() => 0, enforce);
    observer.stop();
    vi.advanceTimersByTime(1000);
    expect(enforce).not.toHaveBeenCalled();
  });

  it("tool batch stats count parallel calls and computer_act batching", () => {
    const stats = new ToolBatchStats();
    stats.recordAssistant([{ type: "text" }]);
    stats.recordAssistant([
      { type: "toolCall", name: "web_search", arguments: {} },
      { type: "toolCall", name: "read_file", arguments: {} },
    ]);
    stats.recordAssistant([
      { type: "toolCall", name: "computer_act", arguments: { actions: [1, 2, 3], observe: false } },
    ]);
    stats.recordAssistant([
      { type: "toolCall", name: "computer_act", arguments: { actions: [1] } },
    ]);
    expect(stats.summary()).toMatchObject({
      assistantMessages: 4,
      toolCallMessages: 3,
      toolCalls: 4,
      parallelMessages: 1,
      maxCallsPerMessage: 2,
      computerActCalls: 2,
      avgActionsPerComputerAct: 2,
      computerActObserves: 1,
    });
  });
});
