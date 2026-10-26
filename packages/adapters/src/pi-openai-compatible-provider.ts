import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import {
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  type OpenAiCompatibleCompat,
} from "@rakazo/contracts";
import { Agent } from "undici";
import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";
import { reportModelTransportError } from "./model-transport-log.js";
import {
  createAddressCheckedLookup,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isPrivateAddress,
  type ResolveHostname,
} from "./network-address.js";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./openai-compatible-url.js";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

export { OPENAI_COMPATIBLE_PROVIDER_ID };

/** Placeholder catalog model id; users enter the real id when connecting. */
export const OPENAI_COMPATIBLE_CATALOG_MODEL_ID = "custom";

/** Model ids this endpoint serves with vision, declared by the operator. */
export const OPENAI_COMPATIBLE_VISION_MODELS_ENV = "RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS";

export function openAiCompatibleVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(OPENAI_COMPATIBLE_VISION_MODELS_ENV);
}

const MAX_MODELS_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_IDS = 500;
/** Pinned catalogs (OpenRouter is ~1 MiB). Custom server URLs stay on the tight caps. */
const CATALOG_MAX_MODELS_RESPONSE_BYTES = 8 * 1024 * 1024;
const CATALOG_MAX_MODEL_IDS = 8_000;
const MAX_MODEL_ID_LENGTH = 256;

function modelsProbeLimits(catalogProbe?: boolean): { maxBytes: number; maxModelIds: number } {
  return catalogProbe
    ? { maxBytes: CATALOG_MAX_MODELS_RESPONSE_BYTES, maxModelIds: CATALOG_MAX_MODEL_IDS }
    : { maxBytes: MAX_MODELS_RESPONSE_BYTES, maxModelIds: MAX_MODEL_IDS };
}

const OPENAI_COMPAT_BASE = "http://127.0.0.1:1/v1";
const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function openAiCompatibleModel(
  id: string,
  baseUrl: string,
  reasoning = false,
  acceptsImages = false,
  maxTokens = DEFAULT_MODEL_MAX_TOKENS,
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
  overrides?: OpenAiCompatibleCompat,
): Model<"openai-completions"> {
  const official = isOfficialOpenAiBaseUrl(baseUrl);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl,
    reasoning,
    compat: {
      supportsDeveloperRole: false,
      // Generic servers often reject the OpenAI-only reasoning_effort field, so
      // "Supports thinking" only enables reasoning parsing there; sending the
      // effort is an explicit per-credential opt-in.
      supportsReasoningEffort: overrides?.supportsReasoningEffort ?? (official ? reasoning : false),
      thinkingFormat: "openai",
      // pi-ai's URL detection treats unknown hosts as OpenAI proper
      // (max_completion_tokens, store, long cache retention). Generic servers
      // such as vLLM/LiteLLM-style gateways reject those, so only the official
      // host keeps them.
      ...(official
        ? {}
        : {
            maxTokensField: "max_tokens" as const,
            supportsStore: false,
            supportsLongCacheRetention: false,
          }),
      ...(overrides?.maxTokensField ? { maxTokensField: overrides.maxTokensField } : {}),
      ...(overrides?.supportsUsageInStreaming !== undefined
        ? { supportsUsageInStreaming: overrides.supportsUsageInStreaming }
        : {}),
    },
    // Thinking "off" omits reasoning_effort on generic servers; only the
    // official API understands the explicit "none" effort.
    ...(official ? { thinkingLevelMap: { off: "none" } } : {}),
    input: inputModalities(acceptsImages),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function openAiCompatibleProvider(models: Model<"openai-completions">[]): Provider {
  const api = openAICompletionsApi();
  // Guard the fetch the caller supplied (the runtime's seam for tests) or the
  // dispatcher-matched default; never the bare global.
  const safeApi: ProviderStreams = {
    stream: (model, context, options) =>
      api.stream(model, context, {
        ...options,
        fetch: createOpenAiCompatibleFetch(options?.fetch),
      }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, {
        ...options,
        fetch: createOpenAiCompatibleFetch(options?.fetch),
      }),
  };
  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: models[0]?.baseUrl ?? OPENAI_COMPAT_BASE,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        resolve: async () => ({
          auth: { apiKey: "local" },
          source: "OpenAI-compatible endpoint",
        }),
      },
    },
    models,
    api: safeApi,
  });
}

export function createOpenAiCompatibleLookup(
  url: URL,
  resolve: ResolveHostname = resolveHostname,
): LookupFunction {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const privateHostname = isPrivateOpenAiCompatibleHostname(hostname);
  return createAddressCheckedLookup(resolve, (addresses) => {
    if (addresses.length === 0) throw new Error("Model server did not resolve to an address");
    if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
      throw new Error("Model server hostname resolved to a blocked metadata address");
    }
    if (privateHostname) {
      if (
        addresses.some(
          (entry) =>
            isIP(entry.address) === 0 ||
            !isPrivateAddress(entry.address) ||
            isLinkLocalAddress(entry.address),
        )
      ) {
        throw new Error("Local model server hostname resolved outside the private network");
      }
      return;
    }
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("Public model server hostname resolved to a private address");
    }
  });
}

function headersCarryAuthorization(headers: HeadersInit): boolean {
  if (headers instanceof Headers) return Boolean(headers.get("authorization"));
  if (Array.isArray(headers)) {
    return headers.some(
      ([name, value]) => name.toLowerCase() === "authorization" && Boolean(value),
    );
  }
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === "authorization" && Boolean(value),
  );
}

/** Matches fetch: when init.headers is set it replaces Request headers entirely. */
function requestCarriesAuthorization(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers !== undefined) return headersCarryAuthorization(init.headers);
  return input instanceof Request ? Boolean(input.headers.get("authorization")) : false;
}

export function createOpenAiCompatibleFetch(
  baseFetch: typeof globalThis.fetch = dispatcherFetch,
  resolve: ResolveHostname = resolveHostname,
  opts?: { allowPublic?: boolean },
): typeof globalThis.fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = assertAllowedOpenAiCompatibleRequestUrl(rawUrl, {
      allowPublic: opts?.allowPublic,
    });
    if (requestCarriesAuthorization(input, init)) {
      assertHttpsForKeyedOpenAiCompatibleUrl(url, "present");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const dispatcher =
      isIP(hostname) === 0
        ? new Agent({
            connect: { lookup: createOpenAiCompatibleLookup(url, resolve) },
          })
        : undefined;
    // Node's fetch rejects this package Agent. Pair them only when the
    // dispatcher is attached; a caller-supplied fetch stays in charge.
    const transport = dispatcher ? fetchPairedWithDispatcher(baseFetch) : baseFetch;
    try {
      const response = await transport(url, {
        ...(await requestInitFor(input, init)),
        redirect: "error",
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: Agent });
      return dispatcher ? await closeDispatcherWithResponse(response, dispatcher) : response;
    } catch (error) {
      await dispatcher?.close().catch(() => undefined);
      // The OpenAI SDK replaces this with "Connection error." and pi-ai keeps only
      // that message, so record the sanitized cause chain here.
      reportModelTransportError(error, url);
      throw error;
    }
  };
}

/** The base fetch comes from the undici package, which recognizes only its own
 * Request class and reads a global Request as the string "[object Request]".
 * Flatten Request inputs to a URL plus init, with init overriding the
 * Request's fields the way fetch itself merges them. */
async function requestInitFor(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  if (!(input instanceof Request)) return init ?? {};
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  };
}

async function closeDispatcherWithResponse(
  response: Response,
  dispatcher: Agent,
): Promise<Response> {
  if (!response.body) {
    await dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Always-visible catalog provider with a placeholder model entry. */
export function openAiCompatibleCatalogProvider(): Provider {
  // The vision gate resolves against this catalog rather than the per-run
  // registry, so a model only declared at runtime would still read as
  // text-only. Register the operator's declared vision models here too.
  //
  // If the reserved placeholder id ("custom") is itself declared vision-
  // capable, upgrade the placeholder entry rather than appending a second
  // model with the same id — Models.getModel returns the first match, so a
  // duplicate would leave the gate reading the text-only placeholder.
  const visionIds = openAiCompatibleVisionModelIds();
  const placeholderAcceptsImages = visionIds.has(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  const visionModels = [...visionIds]
    .filter((id) => id !== OPENAI_COMPATIBLE_CATALOG_MODEL_ID)
    .map((id) => openAiCompatibleModel(id, OPENAI_COMPAT_BASE, false, true));
  return openAiCompatibleProvider([
    {
      ...openAiCompatibleModel(
        OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
        OPENAI_COMPAT_BASE,
        false,
        placeholderAcceptsImages,
      ),
      name: "Custom model id",
    },
    ...visionModels,
  ]);
}

export function registerOpenAiCompatibleCatalog(models: MutableModels): MutableModels {
  models.setProvider(openAiCompatibleCatalogProvider());
  return models;
}

/** Register a concrete model + base URL for an agent run. */
export function registerOpenAiCompatibleRuntime(
  models: MutableModels,
  opts: {
    modelId: string;
    baseUrl: string;
    reasoning?: boolean;
    acceptsImages?: boolean;
    maxTokens?: number;
    contextWindow?: number;
    compat?: OpenAiCompatibleCompat;
  },
): MutableModels {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  const modelId = opts.modelId.trim();
  const acceptsImages = opts.acceptsImages || openAiCompatibleVisionModelIds().has(modelId);
  models.setProvider(
    openAiCompatibleProvider([
      openAiCompatibleModel(
        modelId,
        baseUrl,
        opts.reasoning,
        acceptsImages,
        opts.maxTokens,
        opts.contextWindow,
        opts.compat,
      ),
    ]),
  );
  return models;
}

export type OpenAiCompatibleConnectInput = {
  provider: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
};

export function prepareOpenAiCompatibleConnect(input: OpenAiCompatibleConnectInput): {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
} {
  const baseUrl = input.baseUrl?.trim();
  const modelId = input.modelId?.trim();
  if (!baseUrl) throw new Error("Base URL is required for OpenAI-compatible models");
  if (!modelId) throw new Error("Model id is required for OpenAI-compatible models");
  const allowed = assertAllowedOpenAiCompatibleUrl(baseUrl);
  const apiKey = input.apiKey?.trim();
  assertHttpsForKeyedOpenAiCompatibleUrl(allowed, apiKey);
  const normalized = allowed.href;
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

type OpenAiCompatibleModelEntry = {
  id?: string;
  context_length?: unknown;
  context_window?: unknown;
  contextWindow?: unknown;
  max_model_len?: unknown;
  max_context_length?: unknown;
  top_provider?: { context_length?: unknown } | null;
};

export type OpenAiCompatibleModelsResponse = {
  object?: string;
  data?: Array<OpenAiCompatibleModelEntry>;
  models?: Array<OpenAiCompatibleModelEntry>;
};

/** `/models` ids plus any context lengths the server advertised (OpenRouter, vLLM, LM Studio, ...). */
export type OpenAiCompatibleModelsProbe = {
  models: string[];
  /** Model id -> advertised context window in tokens. Absent ids advertised nothing usable. */
  contextWindows: Record<string, number>;
};

/** Highest plausible window we accept from a probe; mirrors MAX_MODEL_CONTEXT_WINDOW. */
const MAX_PROBED_CONTEXT_WINDOW = 2_147_483_647;
/** Below this the value is almost certainly not a context window (or useless for agents). */
const MIN_PROBED_CONTEXT_WINDOW = 1_024;

function probedContextWindow(entry: OpenAiCompatibleModelEntry): number | undefined {
  const candidates = [
    entry.context_length,
    entry.context_window,
    entry.contextWindow,
    entry.max_model_len,
    entry.max_context_length,
    entry.top_provider?.context_length,
  ];
  for (const candidate of candidates) {
    const value =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate.trim())
          ? Number(candidate.trim())
          : Number.NaN;
    if (
      Number.isSafeInteger(value) &&
      value >= MIN_PROBED_CONTEXT_WINDOW &&
      value <= MAX_PROBED_CONTEXT_WINDOW
    ) {
      return value;
    }
  }
  return undefined;
}

/** Shared suffix: /models probe is optional when the user already knows a model id. */
const OPENAI_COMPAT_PROBE_HAND_FILL_HINT = "You can still Connect with an explicit model id.";

function probeModelList(
  body: OpenAiCompatibleModelsResponse,
  opts?: { catalogProbe?: boolean },
): OpenAiCompatibleModelsProbe {
  const { maxModelIds } = modelsProbeLimits(opts?.catalogProbe);
  const entries = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : null;
  if (!entries) {
    throw new Error(
      `Model server response did not include a models list. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const ids: string[] = [];
  const contextWindows: Record<string, number> = {};
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LENGTH || ids.length >= maxModelIds) {
      throw new Error("Model server returned too many or overly long model ids");
    }
    ids.push(id);
    const contextWindow = probedContextWindow(entry);
    if (contextWindow !== undefined && !Object.hasOwn(contextWindows, id)) {
      contextWindows[id] = contextWindow;
    }
  }
  return { models: ids, contextWindows };
}

async function readBoundedJson(
  response: Response,
  opts?: { catalogProbe?: boolean },
): Promise<OpenAiCompatibleModelsResponse> {
  const { maxBytes } = modelsProbeLimits(opts?.catalogProbe);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
  if (!response.body) {
    throw new Error(
      `Model server returned an empty response. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as OpenAiCompatibleModelsResponse;
  } catch {
    throw new Error(`Model server returned invalid JSON. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
}

export async function probeOpenAiCompatibleModels(
  input: { baseUrl: string; apiKey?: string },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
  opts?: { allowPublic?: boolean; catalogProbe?: boolean },
): Promise<string[]> {
  return (await probeOpenAiCompatibleModelList(input, fetchImpl, signal, opts)).models;
}

/** Same probe as `probeOpenAiCompatibleModels`, keeping advertised context windows. */
export async function probeOpenAiCompatibleModelList(
  input: { baseUrl: string; apiKey?: string },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
  opts?: { allowPublic?: boolean; catalogProbe?: boolean },
): Promise<OpenAiCompatibleModelsProbe> {
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl, {
    allowPublic: opts?.allowPublic,
  });
  assertHttpsForKeyedOpenAiCompatibleUrl(baseUrl, input.apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, opts);
    const response = await safeFetch(new URL("models", `${baseUrl.href}/`).href, {
      headers,
      redirect: "error",
      signal: merged,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server redirects are not allowed. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server returned ${response.status}. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    const body = await readBoundedJson(response, opts);
    return probeModelList(body, opts);
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError");
    if (aborted) {
      // Caller-cancelled probes keep the original AbortError; the 5s probe budget gets a hint.
      if (signal?.aborted) throw error;
      throw new Error(`Model server probe timed out. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
