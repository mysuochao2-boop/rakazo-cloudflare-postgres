import * as z from "zod";
import { Id } from "./ids.js";

/** Live runtime log line for one bot (RAKAZO_BOT_LIVE_LOGS). Metadata only. */
export const BotRuntimeLogEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  lane: z.enum(["interactive", "background"]).nullable(),
  level: z.enum(["info", "warn", "error"]),
  code: z.string(),
  tool: z.string().nullable(),
  ok: z.boolean().nullable(),
  ms: z.number().int().nullable(),
  summary: z.string().nullable(),
});
export type BotRuntimeLogEntry = z.infer<typeof BotRuntimeLogEntrySchema>;

export const BotRuntimeRunSummarySchema = z.object({
  id: Id,
  lane: z.string(),
  trigger: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type BotRuntimeRunSummary = z.infer<typeof BotRuntimeRunSummarySchema>;

export const BotRuntimeBackgroundTaskSchema = z.object({
  id: Id,
  runId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  progress: z.string().nullable(),
  stepsUsed: z.number().int(),
  stepCap: z.number().int(),
  updatedAt: z.string(),
});
export type BotRuntimeBackgroundTask = z.infer<typeof BotRuntimeBackgroundTaskSchema>;

export const BotRuntimeLogsListInput = z.object({
  botId: Id,
  /** Page backwards: only entries with seq < before. */
  before: z.number().int().positive().optional(),
  runId: Id.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const BotRuntimeLogsPageSchema = z.object({
  enabled: z.boolean(),
  /** Oldest first. */
  entries: z.array(BotRuntimeLogEntrySchema),
  /** Highest seq on this page; subscribe after it. -1 when empty. */
  cursor: z.number().int().min(-1),
  runs: z.array(BotRuntimeRunSummarySchema),
  backgroundTasks: z.array(BotRuntimeBackgroundTaskSchema),
});
export type BotRuntimeLogsPage = z.infer<typeof BotRuntimeLogsPageSchema>;

export const BotRuntimeLogsSubscribeInput = z.object({
  botId: Id,
  cursor: z.number().int().min(-1),
});

/** Stream frame: a log line, or a heartbeat that only proves liveness. */
export const BotRuntimeLogStreamItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bot.log.append"), entry: BotRuntimeLogEntrySchema }),
  z.object({ type: z.literal("heartbeat"), ts: z.string() }),
]);
export type BotRuntimeLogStreamItem = z.infer<typeof BotRuntimeLogStreamItemSchema>;
