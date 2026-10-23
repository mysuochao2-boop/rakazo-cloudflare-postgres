import { describe, expect, it, vi } from "vitest";
import {
  applyProbedContextWindow,
  contextWindowFieldValue,
  createModelProbe,
  initialModelProbeState,
  probedContextWindow,
} from "./model-probe.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const onChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const controller = createModelProbe(onChange);
  const input = {
    baseUrl: " https://models.example.test/v1 ",
    apiKey: " fake-key ",
    onSuccess,
    onError,
  };
  return { controller, input, onChange, onSuccess, onError };
}

describe("model probe lifecycle", () => {
  it("normalizes the connection and treats an empty catalog as a successful manual-entry probe", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const request = vi.fn().mockResolvedValue({ models: [] });
    await controller.probe({ ...input, request });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: "fake-key",
    });
    expect(onChange.mock.calls).toEqual([
      [{ models: [], contextWindows: {}, baseUrl: null, probing: true }],
      [
        {
          models: [],
          contextWindows: {},
          baseUrl: "https://models.example.test/v1",
          probing: false,
        },
      ],
    ]);
    expect(onSuccess).toHaveBeenCalledWith([], {});
  });

  it("keeps context windows advertised by the server", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const request = vi
      .fn()
      .mockResolvedValue({ models: ["big", "small"], contextWindows: { big: 1_048_576 } });
    await controller.probe({ ...input, request });
    expect(onChange).toHaveBeenLastCalledWith({
      models: ["big", "small"],
      contextWindows: { big: 1_048_576 },
      baseUrl: "https://models.example.test/v1",
      probing: false,
    });
    expect(onSuccess).toHaveBeenCalledWith(["big", "small"], { big: 1_048_576 });
    expect(probedContextWindow({ big: 1_048_576 }, " big ")).toBe(1_048_576);
    expect(probedContextWindow({ big: 1_048_576 }, "small")).toBeUndefined();
    expect(probedContextWindow({ big: 1_048_576 }, "toString")).toBeUndefined();
  });

  it.each(["provider", "key", "URL"])("ignores a result after the %s changes", async () => {
    const { controller, input, onChange, onSuccess, onError } = setup();
    const pending = deferred<{ models: string[] }>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.reset();
    pending.resolve({ models: ["old-model"] });
    await probe;
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not report errors or update state after unmount", async () => {
    const { controller, input, onChange, onError } = setup();
    const pending = deferred<{ models: string[] }>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.invalidate();
    pending.reject(new Error("old failure"));
    await probe;
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let an older request finish a newer request", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const old = deferred<{ models: string[] }>();
    const current = deferred<{ models: string[] }>();
    const first = controller.probe({ ...input, request: () => old.promise });
    const second = controller.probe({ ...input, request: () => current.promise });
    old.resolve({ models: ["old-model"] });
    await first;
    expect(onChange).toHaveBeenLastCalledWith({
      models: [],
      contextWindows: {},
      baseUrl: null,
      probing: true,
    });
    expect(onSuccess).not.toHaveBeenCalled();
    current.resolve({ models: ["current-model"] });
    await second;
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(["current-model"], {});
  });

  it("clears probing after failure and omits a blank key", async () => {
    const { controller, input, onChange, onError } = setup();
    const error = new Error("unreachable");
    const request = vi.fn().mockRejectedValue(error);
    await controller.probe({ ...input, apiKey: "  ", request });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: undefined,
    });
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("context limit field", () => {
  it("keeps saved limits and leaves new connections empty", () => {
    expect(contextWindowFieldValue(1_048_576)).toBe("1048576");
    expect(contextWindowFieldValue(undefined)).toBe("");
    expect(contextWindowFieldValue(null)).toBe("");
  });

  it("fills from the probe only when empty or still probe-filled", () => {
    expect(applyProbedContextWindow({ current: "", autoFilled: null, probed: 131_072 })).toEqual({
      value: "131072",
      autoFilled: "131072",
    });
    expect(
      applyProbedContextWindow({ current: "131072", autoFilled: "131072", probed: 1_048_576 }),
    ).toEqual({ value: "1048576", autoFilled: "1048576" });
    expect(
      applyProbedContextWindow({ current: "65536", autoFilled: "131072", probed: 1_048_576 }),
    ).toEqual({ value: "65536", autoFilled: "131072" });
    expect(applyProbedContextWindow({ current: "", autoFilled: null, probed: undefined })).toEqual({
      value: "",
      autoFilled: null,
    });
  });
});
