/**
 * Environment feature flags for the agent-runtime upgrade (Phase 0/1).
 * Every flag defaults OFF so an unset environment behaves exactly like before;
 * turning a flag off again is a full rollback (schema changes are additive).
 */
export type EnvLike = Record<string, string | undefined>;

const processEnv = (): EnvLike =>
  (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};

function on(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function idList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export type TurnLimitMode = "off" | "observe" | "enforce";
export type RunLane = "interactive" | "background";

export interface TurnLimits {
  mode: TurnLimitMode;
  /** Tool calls allowed in one run (0 = unlimited). Steps only — no cost caps by design. */
  maxSteps: number;
  /** Wall-clock budget for one run in ms (0 = unlimited). */
  maxWallMs: number;
}

export const DEFAULT_INTERACTIVE_MAX_STEPS = 60;
export const DEFAULT_BACKGROUND_MAX_STEPS = 200;
export const DEFAULT_BACKGROUND_MAX_WALL_MS = 2 * 60 * 60 * 1000;

/** RAKAZO_TURN_LIMITS=off|observe|enforce (default off). */
export function turnLimitMode(env: EnvLike = processEnv()): TurnLimitMode {
  const raw = env.RAKAZO_TURN_LIMITS?.trim().toLowerCase();
  return raw === "observe" || raw === "enforce" ? raw : "off";
}

export function turnLimitsFor(
  lane: RunLane,
  env: EnvLike = processEnv(),
  overrides: { maxSteps?: number | null; maxWallMs?: number | null } = {},
): TurnLimits {
  const mode = turnLimitMode(env);
  const background = lane === "background";
  const maxSteps =
    overrides.maxSteps ??
    (background
      ? positiveInt(env.RAKAZO_BACKGROUND_MAX_STEPS, DEFAULT_BACKGROUND_MAX_STEPS)
      : positiveInt(env.RAKAZO_TURN_MAX_STEPS, DEFAULT_INTERACTIVE_MAX_STEPS));
  const maxWallMs =
    overrides.maxWallMs ??
    (background
      ? positiveInt(env.RAKAZO_BACKGROUND_MAX_WALL_MS, DEFAULT_BACKGROUND_MAX_WALL_MS)
      : positiveInt(env.RAKAZO_TURN_MAX_WALL_MS, 0));
  return { mode, maxSteps, maxWallMs };
}

/** RAKAZO_PARALLEL_TOOL_GUIDANCE=1 adds parallel-call / computer batching prompt guidance. */
export function parallelToolGuidanceEnabled(env: EnvLike = processEnv()): boolean {
  return on(env.RAKAZO_PARALLEL_TOOL_GUIDANCE);
}

/** RAKAZO_TOOL_TELEMETRY=1 logs per-run tool batching statistics (no content). */
export function toolTelemetryEnabled(env: EnvLike = processEnv()): boolean {
  return on(env.RAKAZO_TOOL_TELEMETRY);
}

/** RAKAZO_HISTORY_ASSISTANT_ROLE=1 replays prior assistant turns as role "assistant". */
export function historyAssistantRoleEnabled(env: EnvLike = processEnv()): boolean {
  return on(env.RAKAZO_HISTORY_ASSISTANT_ROLE);
}

/** RAKAZO_TRANSCRIPT_WRITE=1 stores a sanitized structured transcript per run (write-only). */
export function transcriptWriteEnabled(env: EnvLike = processEnv()): boolean {
  return on(env.RAKAZO_TRANSCRIPT_WRITE);
}

export type HistoryFormat = "flat" | "structured";

/**
 * RAKAZO_HISTORY_FORMAT=structured enables structured replay everywhere;
 * RAKAZO_HISTORY_STRUCTURED_SPACES=<spaceId,...> enables it for listed Spaces only.
 * Default flat.
 */
export function historyFormatFor(
  spaceId: string | undefined,
  env: EnvLike = processEnv(),
): HistoryFormat {
  if (env.RAKAZO_HISTORY_FORMAT?.trim().toLowerCase() === "structured") return "structured";
  if (spaceId && idList(env.RAKAZO_HISTORY_STRUCTURED_SPACES).has(spaceId)) return "structured";
  return "flat";
}

/** RAKAZO_BACKGROUND_TASKS=1 exposes background-task tools and multi-lane runtime. */
export function backgroundTasksEnabled(env: EnvLike = processEnv()): boolean {
  return on(env.RAKAZO_BACKGROUND_TASKS);
}

export interface BackgroundTaskLimits {
  perBot: number;
  perSpace: number;
}

export function backgroundTaskLimits(env: EnvLike = processEnv()): BackgroundTaskLimits {
  return {
    perBot: Math.max(1, positiveInt(env.RAKAZO_BACKGROUND_TASKS_PER_BOT, 2)),
    perSpace: Math.max(1, positiveInt(env.RAKAZO_BACKGROUND_TASKS_PER_SPACE, 6)),
  };
}
