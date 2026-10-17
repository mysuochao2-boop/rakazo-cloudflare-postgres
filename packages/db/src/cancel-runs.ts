import type { Prisma } from "./client.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task">,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

export const ACTIVE_BACKGROUND_TASK_STATUSES = ["queued", "running", "waiting_input"] as const;

/** Marks a thread's active background tasks cancelled (thread stop / clear). No wake run. */
export async function cancelBackgroundTasksForThreadInTransaction(
  tx: Pick<Prisma.TransactionClient, "backgroundTask">,
  threadId: string,
  cancelledAt: Date,
): Promise<void> {
  await tx.backgroundTask.updateMany({
    where: { threadId, status: { in: [...ACTIVE_BACKGROUND_TASK_STATUSES] } },
    data: {
      status: "cancelled",
      cancelRequested: true,
      completedAt: cancelledAt,
      error: "Stopped by the user.",
    },
  });
}
