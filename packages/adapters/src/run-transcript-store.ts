import type { AgentRunTranscript } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { RUN_TRANSCRIPT_FORMAT_VERSION, sanitizeTranscript } from "./run-transcript.js";

/** Write-only, best effort: never throws into the run. One row per run (latest attempt wins). */
export async function recordRunTranscript(
  prisma: Pick<PrismaClient, "runTranscript">,
  input: {
    runId: string;
    threadId: string;
    botId: string;
    transcript: AgentRunTranscript;
    secrets: readonly string[];
  },
): Promise<void> {
  const startedAt = Date.now();
  try {
    const sanitized = sanitizeTranscript(input.transcript.messages, input.secrets);
    if (sanitized.messages.length === 0) return;
    const data = {
      threadId: input.threadId,
      botId: input.botId,
      formatVersion: RUN_TRANSCRIPT_FORMAT_VERSION,
      provider: input.transcript.provider,
      modelId: input.transcript.modelId,
      api: input.transcript.api ?? null,
      messages: sanitized.messages as unknown as object,
      truncated: sanitized.truncated,
      bytes: sanitized.bytes,
    };
    await prisma.runTranscript.upsert({
      where: { runId: input.runId },
      create: { runId: input.runId, ...data },
      update: data,
    });
    getLogger().info("agent.transcript_written", {
      runId: input.runId,
      bytes: sanitized.bytes,
      messages: sanitized.messages.length,
      truncated: sanitized.truncated,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    getLogger().warn("Run transcript write failed", { runId: input.runId, error });
  }
}
