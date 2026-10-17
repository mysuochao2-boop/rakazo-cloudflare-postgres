-- CreateTable
CREATE TABLE "bot_runtime_logs" (
    "seq" BIGSERIAL NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT,
    "threadId" TEXT,
    "lane" TEXT,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tool" TEXT,
    "ok" BOOLEAN,
    "ms" INTEGER,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_runtime_logs_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "bot_runtime_logs_botId_seq_idx" ON "bot_runtime_logs"("botId", "seq");

-- CreateIndex
CREATE INDEX "bot_runtime_logs_createdAt_idx" ON "bot_runtime_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "bot_runtime_logs" ADD CONSTRAINT "bot_runtime_logs_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

