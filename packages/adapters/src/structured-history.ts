import { createHash } from "node:crypto";
import type { AgentHistoryTranscript, AgentRunRequest } from "@rakazo/adapter-kit";

/**
 * Structured history replay (RAKAZO_HISTORY_FORMAT / RAKAZO_HISTORY_STRUCTURED_SPACES).
 * Replaces each prior assistant turn that has a RunTranscript with its real
 * assistant/toolCall/toolResult sequence, normalized so providers accept it:
 * - the last FULL_RESULT_RUNS runs keep full tool results; older ones get a one-line summary;
 * - no historical images/screenshots;
 * - every toolCall gets exactly one matching toolResult (missing ones synthesized,
 *   orphans/duplicates dropped); call ids rewritten to stable provider-safe `rk_<hash>`;
 * - thinking blocks / signatures kept only for the exact same provider+api+model;
 * - calls to tools not in the current toolset degrade to assistant text.
 * Output is deterministic for the same inputs so provider prompt caches stay warm.
 */
export const FULL_RESULT_RUNS = 3;
const SUMMARY_CHARS = 200;
const OLD_ARGS_CHARS = 500;
const DEGRADED_CHARS = 300;
export const MISSING_RESULT_TEXT =
  "[no result recorded: the run was interrupted or paused before this tool returned]";

type HistoryEntry = AgentRunRequest["history"][number];
type Json = Record<string, unknown>;

export interface StructuredModel {
  api: string;
  provider: string;
  id: string;
}

export interface StructuredHistoryStats {
  runsReplayed: number;
  toolCalls: number;
  degradedCalls: number;
  synthesizedResults: number;
  droppedResults: number;
  summarizedResults: number;
  droppedThinking: number;
}

export interface StructuredHistoryOptions {
  model: StructuredModel;
  transcripts: readonly AgentHistoryTranscript[];
  /** Original tool name -> exposed (model-facing) name for the current toolset. */
  toolNames: ReadonlyMap<string, string>;
  fullResultRuns?: number;
  /** Builds a (pseudo-)user history message for user entries or leading assistant text. */
  userMessage: (entry: HistoryEntry) => unknown;
  /** Builds a text-only role:"assistant" history message. */
  assistantText: (entry: Pick<HistoryEntry, "id" | "createdAt" | "content">) => unknown;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function normalizedToolCallId(runId: string, id: string): string {
  return `rk_${createHash("sha256").update(`${runId}\u0000${id}`).digest("base64url").slice(0, 40)}`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function resultText(message: Json): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      const record = part as Json;
      if (record?.type === "text" && typeof record.text === "string") return record.text;
      if (record?.type === "image") return "[screenshot omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactArgs(args: unknown, limit: number): Json {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Json) : {};
  const serialized = JSON.stringify(record);
  if (serialized.length <= limit) return record;
  return { _truncated_arguments: `${serialized.slice(0, limit)}…` };
}

interface Group {
  transcript: AgentHistoryTranscript;
  entries: HistoryEntry[];
}

/**
 * Transforms one run's stored transcript into provider-safe replay messages.
 * Exported for tests; `full` keeps tool results verbatim.
 */
export function replayTranscript(
  transcript: AgentHistoryTranscript,
  options: Pick<StructuredHistoryOptions, "model" | "toolNames"> & { full: boolean },
  stats: StructuredHistoryStats = emptyStats(),
): Json[] {
  const sameModel = (message: Json) =>
    message.provider === options.model.provider &&
    message.model === options.model.id &&
    (message.api === undefined || message.api === options.model.api) &&
    transcript.provider === options.model.provider &&
    transcript.modelId === options.model.id;
  const out: Json[] = [];
  const raw = transcript.messages.filter(
    (message): message is Json => Boolean(message) && typeof message === "object",
  );
  for (let index = 0; index < raw.length; index += 1) {
    const message = raw[index]!;
    if (message.role !== "assistant") {
      // toolResults are consumed with their assistant message; anything else is an orphan.
      if (message.role === "toolResult") stats.droppedResults += 1;
      continue;
    }
    const results: Json[] = [];
    while (raw[index + 1]?.role === "toolResult") {
      results.push(raw[index + 1]!);
      index += 1;
    }
    const keepThinking = sameModel(message);
    const content: Json[] = [];
    const calls: Array<{ id: string; name: string; original: string; args: Json }> = [];
    const degradedText: string[] = [];
    const parts = Array.isArray(message.content) ? (message.content as Json[]) : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text) content.push({ type: "text", text: part.text });
      } else if (part.type === "thinking") {
        if (keepThinking) content.push({ ...part });
        else stats.droppedThinking += 1;
      } else if (part.type === "toolCall" && typeof part.id === "string") {
        const original = String(part.name ?? "");
        const exposed = options.toolNames.get(original);
        const args = options.full
          ? ((part.arguments as Json | undefined) ?? {})
          : compactArgs(part.arguments, OLD_ARGS_CHARS);
        if (!exposed) {
          const result = results.find((item) => item.toolCallId === part.id);
          const summary = result ? oneLine(resultText(result), DEGRADED_CHARS) : "no result";
          degradedText.push(
            `[earlier tool call: ${original}(${oneLine(JSON.stringify(args), DEGRADED_CHARS)}) → ${summary}]`,
          );
          stats.degradedCalls += 1;
          continue;
        }
        if (calls.some((call) => call.id === part.id)) continue;
        const id = normalizedToolCallId(transcript.runId, part.id);
        calls.push({ id: part.id, name: exposed, original, args });
        const call: Json = { type: "toolCall", id, name: exposed, arguments: args };
        if (keepThinking && typeof part.thoughtSignature === "string") {
          call.thoughtSignature = part.thoughtSignature;
        }
        content.push(call);
      }
    }
    if (degradedText.length) content.push({ type: "text", text: degradedText.join("\n") });
    if (content.length === 0) {
      stats.droppedResults += results.length;
      continue;
    }
    stats.toolCalls += calls.length;
    out.push({
      role: "assistant",
      content,
      api: keepThinking ? options.model.api : String(message.api ?? transcript.api ?? "unknown"),
      provider: keepThinking
        ? options.model.provider
        : String(message.provider ?? transcript.provider),
      model: keepThinking ? options.model.id : String(message.model ?? transcript.modelId),
      usage: ZERO_USAGE,
      stopReason: calls.length ? "toolUse" : "stop",
      timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
    });
    const used = new Set<string>();
    for (const call of calls) {
      const result = results.find((item) => item.toolCallId === call.id && !used.has(call.id));
      let text: string;
      let isError = false;
      if (!result) {
        stats.synthesizedResults += 1;
        text = MISSING_RESULT_TEXT;
        isError = true;
      } else {
        used.add(call.id);
        isError = result.isError === true;
        const full = resultText(result);
        if (options.full) {
          text = full;
        } else {
          stats.summarizedResults += 1;
          text = `[${call.original} result from an earlier turn, summarized: ${oneLine(full, SUMMARY_CHARS) || "(empty)"}]`;
        }
      }
      out.push({
        role: "toolResult",
        toolCallId: normalizedToolCallId(transcript.runId, call.id),
        toolName: call.name,
        content: [{ type: "text", text }],
        isError,
        timestamp: typeof result?.timestamp === "number" ? result.timestamp : 0,
      });
    }
    stats.droppedResults += results.filter(
      (item) => !calls.some((call) => call.id === item.toolCallId),
    ).length;
  }
  return out;
}

export function emptyStats(): StructuredHistoryStats {
  return {
    runsReplayed: 0,
    toolCalls: 0,
    degradedCalls: 0,
    synthesizedResults: 0,
    droppedResults: 0,
    summarizedResults: 0,
    droppedThinking: 0,
  };
}

function lastText(messages: readonly Json[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "";
  return (last.content as Json[])
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * Builds structured history from already de-duplicated conversational entries.
 * Entries without a transcript fall back to the flat assistant-role text.
 */
export function buildStructuredHistory(
  entries: readonly HistoryEntry[],
  options: StructuredHistoryOptions,
): { messages: unknown[]; stats: StructuredHistoryStats } {
  const stats = emptyStats();
  const byRun = new Map(options.transcripts.map((transcript) => [transcript.runId, transcript]));
  // Recency rank of transcript-backed runs (0 = newest) decides full vs summarized results.
  const runOrder: string[] = [];
  for (const entry of entries) {
    if (entry.role === "assistant" && entry.runId && byRun.has(entry.runId)) {
      if (!runOrder.includes(entry.runId)) runOrder.push(entry.runId);
    }
  }
  const fullRuns = new Set(runOrder.slice(-(options.fullResultRuns ?? FULL_RESULT_RUNS)));
  const groups = new Map<string, Group>();
  const messages: unknown[] = [];
  let seenUser = false;
  const tag = (message: unknown, entry: HistoryEntry, runId?: string) =>
    Object.assign(message as Json, {
      rakazoHistory: true,
      rakazoStructuredHistory: true,
      rakazoMessageId: entry.id,
      rakazoCreatedAt: entry.createdAt,
      ...(runId ? { rakazoRunId: runId } : {}),
    });
  for (const entry of entries) {
    if (entry.role === "user" || !seenUser) {
      if (entry.role === "user") seenUser = true;
      messages.push(tag(options.userMessage(entry), entry));
      continue;
    }
    const transcript = entry.runId ? byRun.get(entry.runId) : undefined;
    if (!transcript) {
      messages.push(tag(options.assistantText(entry), entry));
      continue;
    }
    const existing = groups.get(transcript.runId);
    if (existing) {
      // The run's transcript already covers every assistant message it produced.
      existing.entries.push(entry);
      continue;
    }
    groups.set(transcript.runId, { transcript, entries: [entry] });
    const replay = replayTranscript(
      transcript,
      { model: options.model, toolNames: options.toolNames, full: fullRuns.has(transcript.runId) },
      stats,
    );
    if (replay.length === 0) {
      messages.push(tag(options.assistantText(entry), entry));
      continue;
    }
    stats.runsReplayed += 1;
    for (const message of replay) messages.push(tag(message, entry, transcript.runId));
    // Paused/limited runs can end on a tool result; keep the visible reply text.
    if (!lastText(replay) && entry.content.trim()) {
      messages.push(tag(options.assistantText(entry), entry, transcript.runId));
    }
  }
  return { messages, stats };
}

/** True when a provider error most likely came from the structured history shape. */
export function looksLikeHistoryShapeError(message: string | undefined): boolean {
  if (!message) return false;
  return /\b400\b|invalid[_ ]request|bad request|tool_use|tool_call|tool_result|toolResult|function[_ ]call|thinking|signature|messages\.\d+|must be followed|unexpected role|roles must alternate|unknown tool|not declared|tool result in context/i.test(
    message,
  );
}

/** Swaps structured history for the flat equivalent, keeping the live turn untouched. */
export function flattenStructuredHistory<T>(messages: readonly T[], flat: readonly T[]): T[] {
  const live = messages.filter(
    (message) => !(message as Json & { rakazoStructuredHistory?: boolean }).rakazoStructuredHistory,
  );
  return [...flat, ...live];
}
