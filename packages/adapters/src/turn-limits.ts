import type { RunLane, TurnLimits } from "@rakazo/core";
import { turnLimitsFor } from "@rakazo/core";

/**
 * Per-run step / wall-clock guard. Deliberately has no cost or token caps.
 * - off: inert.
 * - observe: counts and logs the first crossing of each limit; never changes behavior.
 * - enforce: refuses further tool calls past maxSteps and stops the turn at maxWallMs.
 */
export interface TurnLimitEvent {
  kind: "steps" | "wall";
  mode: "observe" | "enforce";
  runId: string;
  lane: RunLane;
  steps: number;
  elapsedMs: number;
  limit: number;
}

export function resolveTurnLimits(
  lane: RunLane | undefined,
  overrides?: { maxSteps?: number | null; maxWallMs?: number | null },
  env?: Record<string, string | undefined>,
): TurnLimits {
  return turnLimitsFor(lane ?? "interactive", env, overrides);
}

/** The tool-call fuse value the existing per-run budget should enforce. 0 = unlimited. */
export function effectiveToolCallLimit(fuse: number, limits: TurnLimits): number {
  if (limits.mode !== "enforce" || limits.maxSteps <= 0) return fuse;
  return fuse > 0 ? Math.min(fuse, limits.maxSteps) : limits.maxSteps;
}

export class TurnLimitObserver {
  private stepsLogged = false;
  private wallLogged = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly startedAt: number;
  wallExceeded = false;

  constructor(
    readonly limits: TurnLimits,
    private readonly runId: string,
    private readonly lane: RunLane,
    private readonly report: (event: TurnLimitEvent) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get active(): boolean {
    return this.limits.mode !== "off";
  }

  /** Called with the cumulative step count whenever a tool call starts. */
  onStep(steps: number): void {
    if (!this.active || this.stepsLogged || this.limits.maxSteps <= 0) return;
    if (steps <= this.limits.maxSteps) return;
    this.stepsLogged = true;
    this.report({
      kind: "steps",
      mode: this.limits.mode as "observe" | "enforce",
      runId: this.runId,
      lane: this.lane,
      steps,
      elapsedMs: this.now() - this.startedAt,
      limit: this.limits.maxSteps,
    });
  }

  /** Arms the wall-clock timer. onEnforce runs only in enforce mode. */
  startWallClock(steps: () => number, onEnforce: () => void): void {
    if (!this.active || this.limits.maxWallMs <= 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.wallLogged) return;
      this.wallLogged = true;
      this.report({
        kind: "wall",
        mode: this.limits.mode as "observe" | "enforce",
        runId: this.runId,
        lane: this.lane,
        steps: steps(),
        elapsedMs: this.now() - this.startedAt,
        limit: this.limits.maxWallMs,
      });
      if (this.limits.mode === "enforce") {
        this.wallExceeded = true;
        onEnforce();
      }
    }, this.limits.maxWallMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function wallClockLimitMessage(maxWallMs: number): string {
  const minutes = Math.max(1, Math.round(maxWallMs / 60_000));
  return `I stopped after reaching the ${minutes}-minute time limit for this turn. Send another message to continue.`;
}

export function stepLimitMessage(limit: number): string {
  return `I stopped after reaching the limit of ${limit} steps (tool calls) in this turn. Send another message to continue.`;
}

/** Content-free batching statistics for one run (C3/C4 telemetry). */
export class ToolBatchStats {
  assistantMessages = 0;
  toolCallMessages = 0;
  toolCalls = 0;
  maxCallsPerMessage = 0;
  parallelMessages = 0;
  computerActCalls = 0;
  computerActions = 0;
  computerObserves = 0;
  computerObserveCalls = 0;

  recordAssistant(
    content: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>,
  ): void {
    this.assistantMessages += 1;
    const calls = content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) return;
    this.toolCallMessages += 1;
    this.toolCalls += calls.length;
    this.maxCallsPerMessage = Math.max(this.maxCallsPerMessage, calls.length);
    if (calls.length > 1) this.parallelMessages += 1;
    for (const call of calls) {
      const args =
        call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : {};
      if (call.name === "computer_act") {
        this.computerActCalls += 1;
        this.computerActions += Array.isArray(args.actions) ? args.actions.length : 0;
        if (args.observe === undefined || args.observe) this.computerObserves += 1;
      } else if (call.name === "computer_observe") {
        this.computerObserveCalls += 1;
      }
    }
  }

  summary(): Record<string, number> {
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      assistantMessages: this.assistantMessages,
      toolCallMessages: this.toolCallMessages,
      toolCalls: this.toolCalls,
      avgCallsPerToolMessage: this.toolCallMessages
        ? round(this.toolCalls / this.toolCallMessages)
        : 0,
      maxCallsPerMessage: this.maxCallsPerMessage,
      parallelMessages: this.parallelMessages,
      computerActCalls: this.computerActCalls,
      avgActionsPerComputerAct: this.computerActCalls
        ? round(this.computerActions / this.computerActCalls)
        : 0,
      computerActObserves: this.computerObserves,
      computerObserveCalls: this.computerObserveCalls,
    };
  }
}
