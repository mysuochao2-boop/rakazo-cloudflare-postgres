/**
 * Bounded waits for best-effort work that sits between a finished model stream and
 * finalizeRun. A heartbeat keeps the run lease alive meanwhile, so an unbounded wait
 * here leaves a zombie "running" run that blocks the lane.
 */
export type DeadlineOutcome<T> = { ok: true; value: T } | { ok: false; timedOut: true };

/**
 * Starts `work` with an abort signal and waits at most `ms`. On timeout the signal is
 * aborted and `{ ok: false }` is returned; a later rejection from the abandoned work is
 * swallowed. A rejection before the deadline propagates.
 */
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  reason = "operation timed out",
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work(controller.signal);
  pending.catch(() => undefined);
  const timeout = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(reason));
      resolve({ ok: false, timedOut: true });
    }, ms);
  });
  try {
    return await Promise.race([pending.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** End-of-run (and pause) workspace checkpoint budget. Past it the idle/sleep checkpoint takes over. */
export const DEFAULT_RUN_CHECKPOINT_TIMEOUT_MS = 120_000;
export function runCheckpointTimeoutMs(env: Record<string, string | undefined> = process.env) {
  return positiveInt(env.RAKAZO_RUN_CHECKPOINT_TIMEOUT_MS, DEFAULT_RUN_CHECKPOINT_TIMEOUT_MS);
}

/**
 * Checkpoint budget before an interactive pause (takeover, ask, approval, secret). Kept
 * short so the user is not left waiting on an export; past it the idle checkpoint runs.
 */
export const DEFAULT_INTERACTIVE_CHECKPOINT_TIMEOUT_MS = 15_000;
export function interactiveCheckpointTimeoutMs(
  env: Record<string, string | undefined> = process.env,
) {
  return positiveInt(
    env.RAKAZO_INTERACTIVE_CHECKPOINT_TIMEOUT_MS,
    DEFAULT_INTERACTIVE_CHECKPOINT_TIMEOUT_MS,
  );
}

/** Best-effort RunTranscript write budget. */
export const DEFAULT_TRANSCRIPT_WRITE_TIMEOUT_MS = 15_000;
export function transcriptWriteTimeoutMs(env: Record<string, string | undefined> = process.env) {
  return positiveInt(env.RAKAZO_TRANSCRIPT_WRITE_TIMEOUT_MS, DEFAULT_TRANSCRIPT_WRITE_TIMEOUT_MS);
}
