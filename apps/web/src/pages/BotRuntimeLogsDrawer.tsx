import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotRuntimeBackgroundTask,
  BotRuntimeLogEntry,
  BotRuntimeRunSummary,
} from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
  Toggle,
} from "@rakazo/ui-web";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildRunCards,
  filterLogEntries,
  formatDuration,
  formatLogLine,
  isProblemEntry,
  type LaneFilter,
  mergeLogEntries,
  shouldRefreshOverview,
} from "../lib/bot-runtime-logs";
import { useCopyText } from "../lib/copy-text";
import { rpc } from "../lib/rpc";

const RECONNECT_MS = 2_000;
const OVERVIEW_REFRESH_MS = 15_000;

function timeOf(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Live runtime log drawer for one bot (RAKAZO_BOT_LIVE_LOGS). Loads recent history,
 * then follows `bots.logs.subscribe` and reconnects from the last seen line.
 */
export function BotRuntimeLogsDrawer({
  botId,
  botName,
  botColor,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [entries, setEntries] = useState<BotRuntimeLogEntry[]>([]);
  const [runs, setRuns] = useState<BotRuntimeRunSummary[]>([]);
  const [tasks, setTasks] = useState<BotRuntimeBackgroundTask[]>([]);
  const [state, setState] = useState<"loading" | "live" | "reconnecting" | "off" | "failed">(
    "loading",
  );
  const [lane, setLane] = useState<LaneFilter>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [runFilter, setRunFilter] = useState<string | null>(null);
  const [copiedRun, setCopiedRun] = useState<string | null>(null);
  const [copied, copy] = useCopyText();
  const [reloadKey, setReloadKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const abort = new AbortController();
    let cursor = -1;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setState("loading");
    setEntries([]);

    const refreshOverview = async () => {
      const page = await rpc.bots.logs.list({ botId, limit: 1 }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setRuns(page.runs);
      setTasks(page.backgroundTasks);
    };
    const scheduleOverview = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshOverview().catch(() => undefined);
      }, 800);
    };
    const poll = setInterval(
      () => void refreshOverview().catch(() => undefined),
      OVERVIEW_REFRESH_MS,
    );

    const run = async () => {
      const page = await rpc.bots.logs.list({ botId, limit: 300 }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!page.enabled) {
        setState("off");
        return;
      }
      setEntries(page.entries);
      setRuns(page.runs);
      setTasks(page.backgroundTasks);
      cursor = page.cursor;
      while (!abort.signal.aborted) {
        try {
          const stream = await rpc.bots.logs.subscribe({ botId, cursor }, { signal: abort.signal });
          setState("live");
          for await (const item of stream) {
            if (abort.signal.aborted) return;
            if (item.type !== "bot.log.append") continue;
            cursor = Math.max(cursor, item.entry.seq);
            setEntries((current) => mergeLogEntries(current, [item.entry]));
            if (shouldRefreshOverview(item.entry)) scheduleOverview();
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        setState("reconnecting");
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
      }
    };
    void run().catch(() => {
      if (!abort.signal.aborted) setState("failed");
    });
    return () => {
      abort.abort();
      clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [botId, reloadKey]);

  const runLanes = useMemo(() => new Map(runs.map((run) => [run.id, run.lane])), [runs]);
  const visible = useMemo(
    () => filterLogEntries(entries, { lane, errorsOnly, runId: runFilter }, runLanes),
    [entries, lane, errorsOnly, runFilter, runLanes],
  );
  const cards = useMemo(
    () => buildRunCards(entries, runs).filter((card) => lane === "all" || card.lane === lane),
    [entries, runs, lane],
  );
  const activeTasks = tasks.filter(
    (task) =>
      task.status === "queued" || task.status === "running" || task.status === "waiting_input",
  );

  // Follow the tail only while the reader is already at the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  }, [visible.length]);

  const copyRunId = (runId: string) => {
    copy(runId);
    setCopiedRun(runId);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="bot-runtime-logs"
        showCloseButton={false}
        className="top-0 right-0 left-auto flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground sm:max-w-[640px]"
      >
        <div className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <BotAvatar color={botColor} identity={botId} size={28} />
            <DialogTitle className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
              {t`${botName} · Runtime logs`}
            </DialogTitle>
            {state === "live" ? (
              <span className="text-[12px] text-success">
                <Trans>Live</Trans>
              </span>
            ) : state === "reconnecting" ? (
              <span className="text-[12px] text-warning">
                <Trans>Reconnecting…</Trans>
              </span>
            ) : null}
          </div>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="sm" />}>
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {state === "off" || state === "failed" || state === "loading" ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            {state === "loading" ? (
              <Trans>Loading…</Trans>
            ) : state === "off" ? (
              <Trans>Runtime logs are off.</Trans>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Trans>Could not load runtime logs.</Trans>
                <Button variant="outline" size="sm" onClick={() => setReloadKey((v) => v + 1)}>
                  <Trans>Retry now</Trans>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-sidebar-border px-[18px] py-2.5">
              <NativeSelect
                aria-label={t`Lane`}
                data-testid="bot-runtime-logs-lane"
                size="sm"
                value={lane}
                onChange={(event) => setLane(event.target.value as LaneFilter)}
              >
                <NativeSelectOption value="all">{t`All lanes`}</NativeSelectOption>
                <NativeSelectOption value="interactive">{t`Interactive`}</NativeSelectOption>
                <NativeSelectOption value="background">{t`Background`}</NativeSelectOption>
              </NativeSelect>
              <Toggle
                variant="outline"
                size="sm"
                pressed={errorsOnly}
                onPressedChange={setErrorsOnly}
                data-testid="bot-runtime-logs-errors"
              >
                <Trans>Errors only</Trans>
              </Toggle>
              {runFilter ? (
                <Button variant="ghost" size="sm" onClick={() => setRunFilter(null)}>
                  {t`Run ${runFilter.slice(-8)} ×`}
                </Button>
              ) : null}
            </div>

            {cards.length || activeTasks.length ? (
              <div className="flex max-h-[38%] flex-col gap-2 overflow-y-auto border-b border-sidebar-border px-[18px] py-3">
                {activeTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-[12.5px]"
                  >
                    <span className="min-w-0 truncate" dir="auto">
                      {task.title}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {task.status} · {task.stepsUsed}/{task.stepCap}
                    </span>
                  </div>
                ))}
                {cards.map((card) => {
                  const failed = card.status === "failed" || card.problems > 0;
                  return (
                    <div
                      key={card.runId}
                      data-testid="bot-runtime-run"
                      className={`rounded-lg border px-3 py-2 text-[12.5px] ${
                        runFilter === card.runId ? "border-foreground/40" : "border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="min-w-0 truncate text-start font-medium"
                          onClick={() =>
                            setRunFilter((current) => (current === card.runId ? null : card.runId))
                          }
                        >
                          {card.lane} · {card.trigger ?? "run"} ·{" "}
                          <span className={failed ? "text-destructive" : undefined}>
                            {card.status ?? "…"}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
                          <span>{timeOf(card.startedAt)}</span>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t`Copy run ID`}
                            onClick={() => copyRunId(card.runId)}
                          >
                            <Copy />
                          </Button>
                          {copied && copiedRun === card.runId ? (
                            <span className="text-success">
                              <Trans>Copied</Trans>
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {card.milestones.length || card.toolCalls ? (
                        <div className="mt-1 text-muted-foreground">
                          {card.milestones
                            .map((m) => `${m.label} ${formatDuration(m.offsetMs)}`)
                            .join(" → ")}
                          {card.toolCalls
                            ? ` · ${card.toolCalls} tools${
                                card.toolFailures ? ` (${card.toolFailures} failed)` : ""
                              }`
                            : ""}
                        </div>
                      ) : null}
                      {card.error ? (
                        <div className="mt-1 text-destructive" dir="auto">
                          {card.error}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div
              ref={scrollRef}
              data-testid="bot-runtime-log-lines"
              onScroll={(event) => {
                const element = event.currentTarget;
                pinnedToBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 24;
              }}
              className="rk-scroll min-h-0 flex-1 overflow-y-auto px-[18px] py-2 font-mono text-[12px] leading-[1.6]"
            >
              {visible.length === 0 ? (
                <div className="py-8 text-center font-sans text-[13px] text-muted-foreground/80">
                  <Trans>No runtime logs yet.</Trans>
                </div>
              ) : (
                visible.map((entry) => (
                  <div
                    key={entry.seq}
                    className={`flex gap-2 ${isProblemEntry(entry) ? "text-destructive" : ""}`}
                  >
                    <span className="shrink-0 text-muted-foreground">{timeOf(entry.ts)}</span>
                    {entry.lane === "background" ? (
                      <span className="shrink-0 text-muted-foreground">bg</span>
                    ) : null}
                    <span className="min-w-0 break-all">{formatLogLine(entry)}</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
