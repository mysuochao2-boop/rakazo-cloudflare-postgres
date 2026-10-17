-- CreateTable
CREATE TABLE "run_transcripts" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "api" TEXT,
    "messages" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_transcripts_runId_key" ON "run_transcripts"("runId");

-- CreateIndex
CREATE INDEX "run_transcripts_threadId_createdAt_idx" ON "run_transcripts"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "run_transcripts" ADD CONSTRAINT "run_transcripts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

