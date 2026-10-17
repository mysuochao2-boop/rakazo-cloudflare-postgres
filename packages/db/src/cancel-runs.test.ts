import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelBackgroundTasksForThreadInTransaction } from "./cancel-runs.js";

afterEach(() => {
  delete process.env.RAKAZO_BACKGROUND_TASKS;
});

describe("cancelBackgroundTasksForThreadInTransaction", () => {
  it("is a no-op while RAKAZO_BACKGROUND_TASKS is off", async () => {
    const updateMany = vi.fn();
    await cancelBackgroundTasksForThreadInTransaction(
      { backgroundTask: { updateMany } } as never,
      "thread-1",
      new Date(0),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("cancels the thread's active tasks when enabled", async () => {
    process.env.RAKAZO_BACKGROUND_TASKS = "1";
    const updateMany = vi.fn();
    const now = new Date(0);
    await cancelBackgroundTasksForThreadInTransaction(
      { backgroundTask: { updateMany } } as never,
      "thread-1",
      now,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", status: { in: ["queued", "running", "waiting_input"] } },
      data: expect.objectContaining({
        status: "cancelled",
        cancelRequested: true,
        completedAt: now,
      }),
    });
  });
});
