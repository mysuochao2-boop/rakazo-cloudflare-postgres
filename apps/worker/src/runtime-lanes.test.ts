import { describe, expect, it } from "vitest";
import { backgroundLaneCapacity, RuntimeLaneSlots } from "./runtime-lanes.js";

describe("RuntimeLaneSlots", () => {
  it("keeps the legacy single slot when background lanes are disabled", () => {
    const slots = new RuntimeLaneSlots(0);
    expect(slots.tryAcquire("bg-1", "background")).toEqual({ ok: true });
    const blocked = slots.tryAcquire("int-1", "interactive");
    expect(blocked).toMatchObject({ ok: false, duplicate: false, activeRunIds: ["bg-1"] });
  });

  it("runs one interactive run alongside up to N background runs", () => {
    const slots = new RuntimeLaneSlots(2);
    expect(slots.tryAcquire("bg-1", "background").ok).toBe(true);
    expect(slots.tryAcquire("bg-2", "background").ok).toBe(true);
    expect(slots.tryAcquire("bg-3", "background")).toMatchObject({
      ok: false,
      lane: "background",
      activeRunIds: ["bg-1", "bg-2"],
    });
    // A full background lane never blocks the interactive lane.
    expect(slots.tryAcquire("int-1", null).ok).toBe(true);
    expect(slots.tryAcquire("int-2", "interactive")).toMatchObject({
      ok: false,
      lane: "interactive",
      activeRunIds: ["int-1"],
    });
    expect(slots.occupancy()).toEqual({ interactive: ["int-1"], background: ["bg-1", "bg-2"] });
    slots.release("bg-1");
    expect(slots.tryAcquire("bg-3", "background").ok).toBe(true);
  });

  it("reports a duplicate delivery of an active run", () => {
    const slots = new RuntimeLaneSlots(2);
    slots.tryAcquire("int-1", "interactive");
    expect(slots.tryAcquire("int-1", "interactive")).toMatchObject({ ok: false, duplicate: true });
  });

  it("reads capacity from the flag", () => {
    expect(backgroundLaneCapacity({})).toBe(0);
    expect(backgroundLaneCapacity({ RAKAZO_BACKGROUND_TASKS: "1" })).toBe(2);
    expect(
      backgroundLaneCapacity({
        RAKAZO_BACKGROUND_TASKS: "1",
        RAKAZO_BACKGROUND_LANES_PER_BOT: "1",
      }),
    ).toBe(1);
  });
});
