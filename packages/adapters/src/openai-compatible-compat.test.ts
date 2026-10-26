import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { parseModelSecret } from "./pi-oauth.js";
import {
  openAiCompatibleModel,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";

type Body = Record<string, unknown>;

const modelId = "muse-test";
const context: Context = {
  systemPrompt: "Answer briefly.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};

function sse(): string {
  const chunks = [{ content: "Hello." }, {}].map((delta, index) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: index === 1 ? "stop" : null }],
  }));
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

let server: Server | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function startServer(bodies: Body[]): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse());
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function runAgainst(
  baseUrl: string,
  opts: { reasoning?: boolean; compat?: Parameters<typeof openAiCompatibleModel>[6] } = {},
  reasoningEffort?: "low" | "high",
) {
  const models = registerOpenAiCompatibleRuntime(builtinModels(), {
    modelId,
    baseUrl,
    reasoning: opts.reasoning,
    maxTokens: 4096,
    compat: opts.compat,
  });
  const model = models.getModel("openai-compatible", modelId) as Model<"openai-completions">;
  const stream = models.streamSimple(model, context, {
    maxTokens: 4096,
    ...(reasoningEffort ? { reasoning: reasoningEffort } : {}),
  });
  for await (const _event of stream) {
    // drain
  }
  return stream.result();
}

describe("OpenAI-compatible custom baseUrl wire compat", () => {
  it("sends max_tokens and no max_completion_tokens/store to a local server", async () => {
    const bodies: Body[] = [];
    const baseUrl = await startServer(bodies);
    const result = await runAgainst(baseUrl);
    expect(result.stopReason).toBe("stop");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("store");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("omits reasoning_effort when reasoning is on but thinking is off, and keeps explicit efforts", async () => {
    const bodies: Body[] = [];
    const baseUrl = await startServer(bodies);
    await runAgainst(baseUrl, { reasoning: true });
    await runAgainst(baseUrl, { reasoning: true }, "high");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]?.reasoning_effort).toBe("high");
  });

  it("applies whitelisted credential compat overrides", async () => {
    const bodies: Body[] = [];
    const baseUrl = await startServer(bodies);
    await runAgainst(
      baseUrl,
      {
        reasoning: true,
        compat: {
          maxTokensField: "max_completion_tokens",
          supportsUsageInStreaming: false,
          supportsReasoningEffort: false,
        },
      },
      "high",
    );
    const body = bodies[0]!;
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("stream_options");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("store");
  });

  it("keeps max_completion_tokens and store for the official OpenAI baseUrl", async () => {
    let body: Body | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Body;
      return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    });
    const model = openAiCompatibleModel(modelId, "https://api.openai.com/v1", true, false, 4096);
    const api = openAICompletionsApi();
    const stream = api.streamSimple(model, context as Parameters<typeof api.streamSimple>[1], {
      apiKey: "test-key",
      maxTokens: 4096,
      fetch: mockFetch,
    });
    for await (const _event of stream) {
      // drain
    }
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(body?.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body?.store).toBe(false);
    expect(body?.reasoning_effort).toBe("none");
  });
});

describe("OpenAI-compatible compat persistence", () => {
  const baseUrl = "http://127.0.0.1:8090/v1";

  it("stores, keeps and clears whitelisted compat on the connection secret", () => {
    const first = buildModelConnectPlaintext({
      provider: "openai-compatible",
      baseUrl,
      modelId,
      compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: false },
    });
    const parsed = parseModelSecret(first);
    expect(parsed.kind === "openai_compatible" && parsed.compat).toEqual({
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: false,
    });
    const kept = parseModelSecret(
      buildModelConnectPlaintext({ provider: "openai-compatible", baseUrl, modelId }, first),
    );
    expect(kept.kind === "openai_compatible" && kept.compat).toEqual({
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: false,
    });
    const cleared = parseModelSecret(
      buildModelConnectPlaintext(
        { provider: "openai-compatible", baseUrl, modelId, compat: null },
        first,
      ),
    );
    expect(cleared.kind === "openai_compatible" && cleared.compat).toBeUndefined();
  });

  it("rejects non-whitelisted compat fields at the connect boundary", () => {
    const base = { provider: "openai-compatible", baseUrl, modelId };
    expect(
      ModelConnectInputSchema.safeParse({ ...base, compat: { maxTokensField: "max_tokens" } })
        .success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ ...base, compat: { supportsStore: true } }).success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({ ...base, compat: { maxTokensField: "tokens" } }).success,
    ).toBe(false);
  });

  it("drops non-whitelisted compat fields from stored secrets", () => {
    const parsed = parseModelSecret(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl,
        compat: { maxTokensField: "bogus", supportsStore: true, supportsReasoningEffort: false },
      }),
    );
    expect(parsed.kind === "openai_compatible" && parsed.compat).toEqual({
      supportsReasoningEffort: false,
    });
  });
});
