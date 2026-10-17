-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "backgroundTaskId" TEXT,
ADD COLUMN     "lane" TEXT NOT NULL DEFAULT 'interactive';

-- CreateTable
CREATE TABLE "background_tasks" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "runId" TEXT,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" TEXT,
    "resultSummary" TEXT,
    "error" TEXT,
    "toolProfile" TEXT NOT NULL DEFAULT 'headless',
    "stepCap" INTEGER NOT NULL,
    "wallCapMs" INTEGER NOT NULL,
    "stepsUsed" INTEGER NOT NULL DEFAULT 0,
    "notifyMode" TEXT NOT NULL DEFAULT 'wake',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "wakeGeneration" INTEGER NOT NULL DEFAULT -1,
    "inbox" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "background_tasks_operationKey_key" ON "background_tasks"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "background_tasks_runId_key" ON "background_tasks"("runId");

-- CreateIndex
CREATE INDEX "background_tasks_botId_status_idx" ON "background_tasks"("botId", "status");

-- CreateIndex
CREATE INDEX "background_tasks_spaceId_status_idx" ON "background_tasks"("spaceId", "status");

-- CreateIndex
CREATE INDEX "background_tasks_threadId_createdAt_idx" ON "background_tasks"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "runs_botId_lane_status_idx" ON "runs"("botId", "lane", "status");

