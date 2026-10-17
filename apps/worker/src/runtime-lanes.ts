/**
 * Per-bot runtime lane slots (RAKAZO_BACKGROUND_TASKS). One interactive slot plus up to
 * `background` slots. With background lanes disabled every run shares the single slot,
 * exactly like the previous one-active-run runtime.
 */
export type RuntimeLane = "interactive" | "background";

export interface LaneSlot<T = unknown> {
  runId: string;
  lane: RuntimeLane;
  task?: T;
}

export type LaneAcquire =
  | { ok: true }
  | { ok: false; duplicate: boolean; lane: RuntimeLane; activeRunIds: string[] };

export class RuntimeLaneSlots<T = unknown> {
  readonly active = new Map<string, LaneSlot<T>>();

  constructor(private readonly backgroundCapacity: number) {}

  /** Lane a run is admitted into; background runs fall back to the shared slot when disabled. */
  laneOf(requested: string | null | undefined): RuntimeLane {
    return requested === "background" && this.backgroundCapacity > 0 ? "background" : "interactive";
  }

  private inLane(lane: RuntimeLane): LaneSlot<T>[] {
    return [...this.active.values()].filter((slot) => slot.lane === lane);
  }

  /** Cheap pre-check before any I/O: true when the run is already active here. */
  has(runId: string): boolean {
    return this.active.has(runId);
  }

  tryAcquire(runId: string, requestedLane: string | null | undefined): LaneAcquire {
    const lane = this.laneOf(requestedLane);
    if (this.active.has(runId)) {
      return { ok: false, duplicate: true, lane, activeRunIds: [runId] };
    }
    const capacity =
      this.backgroundCapacity > 0 ? (lane === "background" ? this.backgroundCapacity : 1) : 1;
    // Disabled: one slot for everything (legacy behavior).
    const occupying = this.backgroundCapacity > 0 ? this.inLane(lane) : [...this.active.values()];
    if (occupying.length >= capacity) {
      return {
        ok: false,
        duplicate: false,
        lane,
        activeRunIds: occupying.map((slot) => slot.runId),
      };
    }
    this.active.set(runId, { runId, lane });
    return { ok: true };
  }

  attach(runId: string, task: T): void {
    const slot = this.active.get(runId);
    if (slot) slot.task = task;
  }

  release(runId: string): void {
    this.active.delete(runId);
  }

  occupancy(): Record<RuntimeLane, string[]> {
    return {
      interactive: this.inLane("interactive").map((slot) => slot.runId),
      background: this.inLane("background").map((slot) => slot.runId),
    };
  }
}

export function backgroundLaneCapacity(env: Record<string, string | undefined>): number {
  const enabled = ["1", "true", "on", "yes"].includes(
    (env.RAKAZO_BACKGROUND_TASKS ?? "").trim().toLowerCase(),
  );
  if (!enabled) return 0;
  const raw = Number(
    env.RAKAZO_BACKGROUND_LANES_PER_BOT ?? env.RAKAZO_BACKGROUND_TASKS_PER_BOT ?? 2,
  );
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 4) : 2;
}
