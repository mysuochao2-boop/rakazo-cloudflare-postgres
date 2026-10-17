import { describe, expect, it } from "vitest";
import { runCheckpointTimeoutMs, transcriptWriteTimeoutMs, withDeadline } from "./deadline.js";

describe("withDeadline", () => {
  it("returns the value when work finishes in time", async () => {
    await expect(withDeadline(1_000, async () => 42)).resolves.toEqual({ ok: true, value: 42 });
  });

  it("aborts and gives up on work that never settles", async () => {
    let seen: AbortSignal | undefined;
    const outcome = await withDeadline(20, (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    expect(outcome).toEqual({ ok: false, timedOut: true });
    expect(seen?.aborted).toBe(true);
  });

  it("swallows a late rejection from abandoned work", async () => {
    const outcome = await withDeadline(
      10,
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => setTimeout(() => reject(new Error("late")), 5));
        }),
    );
    expect(outcome.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("propagates an early rejection", async () => {
    await expect(
      withDeadline(1_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("reads budgets from env with sane defaults", () => {
    expect(runCheckpointTimeoutMs({})).toBe(120_000);
    expect(runCheckpointTimeoutMs({ RAKAZO_RUN_CHECKPOINT_TIMEOUT_MS: "5000" })).toBe(5_000);
    expect(runCheckpointTimeoutMs({ RAKAZO_RUN_CHECKPOINT_TIMEOUT_MS: "nope" })).toBe(120_000);
    expect(transcriptWriteTimeoutMs({})).toBe(15_000);
  });
});
