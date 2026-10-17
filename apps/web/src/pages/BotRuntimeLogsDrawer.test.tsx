// @vitest-environment jsdom

import type { BotRuntimeLogEntry, BotRuntimeLogStreamItem } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { bots: { logs: { list: api.list, subscribe: api.subscribe } } },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + part + (index < values.length ? values[index] : ""),
      "",
    );
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => <span />,
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: ({ children, ...props }: ComponentProps<"div">) => (
      <div data-testid={(props as { "data-testid"?: string })["data-testid"]}>{children}</div>
    ),
    DialogTitle: Container,
    NativeSelect: ({ size: _size, ...props }: ComponentProps<"select"> & { size?: string }) => (
      <select {...props} />
    ),
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Toggle: ({
      pressed,
      onPressedChange,
      children,
      ...props
    }: {
      pressed: boolean;
      onPressedChange: (value: boolean) => void;
      children: ReactNode;
    }) => (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => onPressedChange(!pressed)}
        {...(props as object)}
      >
        {children}
      </button>
    ),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { BotRuntimeLogsDrawer } from "./BotRuntimeLogsDrawer";

function line(seq: number, overrides: Partial<BotRuntimeLogEntry> = {}): BotRuntimeLogEntry {
  return {
    seq,
    ts: new Date(Date.UTC(2026, 9, 17, 7, 0, seq)).toISOString(),
    runId: "run-abcdef12",
    threadId: "thread-1",
    lane: "interactive",
    level: "info",
    code: "tool.end",
    tool: "shell",
    ok: true,
    ms: 120,
    summary: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

it("shows history, streams new lines, and filters to problems", async () => {
  api.list.mockResolvedValue({
    enabled: true,
    entries: [line(1, { code: "send.enqueued", tool: null, ms: null })],
    cursor: 1,
    runs: [
      {
        id: "run-abcdef12",
        lane: "interactive",
        trigger: "user",
        status: "running",
        error: null,
        createdAt: line(1).ts,
        startedAt: null,
        completedAt: null,
      },
    ],
    backgroundTasks: [],
  });
  let push: ((item: BotRuntimeLogStreamItem) => void) | undefined;
  api.subscribe.mockImplementation(async (_input: unknown, options: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      while (!options.signal.aborted) {
        yield await new Promise<BotRuntimeLogStreamItem>((resolve) => {
          push = resolve;
        });
      }
    },
  }));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BotRuntimeLogsDrawer botId="bot-1" botName="Ada" botColor="#000" onClose={() => {}} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.subscribe).toHaveBeenCalledWith(
    { botId: "bot-1", cursor: 1 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const lines = () =>
    container.querySelector('[data-testid="bot-runtime-log-lines"]')?.textContent ?? "";
  expect(lines()).toContain("send.enqueued");
  expect(container.querySelectorAll('[data-testid="bot-runtime-run"]')).toHaveLength(1);

  await act(async () => {
    push?.({ type: "bot.log.append", entry: line(2, { tool: "browser", ok: false, ms: 900 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(lines()).toContain("tool.end · browser · failed · 900ms");

  await act(async () => {
    (
      container.querySelector('[data-testid="bot-runtime-logs-errors"]') as HTMLButtonElement
    ).click();
  });
  expect(lines()).not.toContain("send.enqueued");
  expect(lines()).toContain("browser");
  act(() => root.unmount());
});

it("says so when live logs are off", async () => {
  api.list.mockResolvedValue({
    enabled: false,
    entries: [],
    cursor: -1,
    runs: [],
    backgroundTasks: [],
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BotRuntimeLogsDrawer botId="bot-1" botName="Ada" botColor="#000" onClose={() => {}} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain("Runtime logs are off.");
  expect(api.subscribe).not.toHaveBeenCalled();
  act(() => root.unmount());
});
