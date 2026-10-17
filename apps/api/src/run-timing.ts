/**
 * Structured per-step latency markers. One JSON object per line on stdout so
 * Cloudflare Container logs / Workers Observability can filter on
 * `rakazo_timing` and group by runId. Never include prompt text, args, or secrets.
 */
export function logRunTiming(
  step: string,
  fields: { runId?: string; threadId?: string | null; [key: string]: unknown } = {},
): void {
  try {
    process.stdout.write(
      `${JSON.stringify({ rakazo_timing: step, ts: new Date().toISOString(), ...fields })}\n`,
    );
  } catch {
    // Timing must never affect a run.
  }
}
