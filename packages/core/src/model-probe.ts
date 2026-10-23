export type ModelProbeState = {
  models: string[];
  /** Model id -> context window advertised by the server's /models list, when present. */
  contextWindows: Record<string, number>;
  baseUrl: string | null;
  probing: boolean;
};

export const initialModelProbeState: ModelProbeState = {
  models: [],
  contextWindows: {},
  baseUrl: null,
  probing: false,
};

/** The advertised window for one probed model, if the server reported one. */
export function probedContextWindow(
  contextWindows: Record<string, number> | undefined,
  modelId: string,
): number | undefined {
  const id = modelId.trim();
  if (!id || !contextWindows || !Object.hasOwn(contextWindows, id)) return undefined;
  const value = contextWindows[id];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Keep only the latest probe, including when its connection changes or its screen closes. */
export function createModelProbe(onChange: (state: ModelProbeState) => void) {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    reset() {
      revision += 1;
      onChange(initialModelProbeState);
    },
    async probe(options: {
      baseUrl: string;
      apiKey: string;
      request: (input: {
        baseUrl: string;
        apiKey?: string;
      }) => Promise<{ models: string[]; contextWindows?: Record<string, number> }>;
      onSuccess: (models: string[], contextWindows: Record<string, number>) => void;
      onError: (error: unknown) => void;
    }) {
      const baseUrl = options.baseUrl.trim();
      if (!baseUrl) return;
      const requestRevision = ++revision;
      onChange({ models: [], contextWindows: {}, baseUrl: null, probing: true });
      try {
        const { models, contextWindows = {} } = await options.request({
          baseUrl,
          apiKey: options.apiKey.trim() || undefined,
        });
        if (requestRevision !== revision) return;
        onChange({ models, contextWindows, baseUrl, probing: false });
        options.onSuccess(models, contextWindows);
      } catch (error) {
        if (requestRevision !== revision) return;
        onChange(initialModelProbeState);
        options.onError(error);
      }
    },
  };
}

/**
 * Initial "Context limit" field text. A saved value is kept as is; anything else
 * starts empty so the user (or a probe) supplies the model's real window instead
 * of silently inheriting a small default.
 */
export function contextWindowFieldValue(saved: number | null | undefined): string {
  return typeof saved === "number" && Number.isSafeInteger(saved) && saved > 0 ? String(saved) : "";
}

/**
 * Fill "Context limit" from a probed window only when the field is empty or still
 * holds the previous probe fill; a value the user typed (or a saved one) wins.
 */
export function applyProbedContextWindow(options: {
  current: string;
  autoFilled: string | null;
  probed: number | undefined;
}): { value: string; autoFilled: string | null } {
  const { current, autoFilled, probed } = options;
  const replaceable = !current.trim() || (autoFilled !== null && current === autoFilled);
  if (probed === undefined || !replaceable) return { value: current, autoFilled };
  const value = String(probed);
  return { value, autoFilled: value };
}
