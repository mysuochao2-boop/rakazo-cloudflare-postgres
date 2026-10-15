import type { RunDispatcher } from "@rakazo/adapter-kit";

export class CloudflareRunDispatcher implements RunDispatcher {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async dispatch(input: { runId: string; botId: string }): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Bot runtime dispatch failed (${response.status}): ${body.slice(0, 200)}`);
    }
  }
}

export function runDispatcherFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): RunDispatcher | undefined {
  const url = env.RUNTIME_DISPATCH_URL?.trim();
  const token = env.RUNTIME_DISPATCH_SECRET?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) {
    throw new Error("RUNTIME_DISPATCH_URL and RUNTIME_DISPATCH_SECRET must be configured together");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("RUNTIME_DISPATCH_URL must be an HTTPS URL without credentials");
  }
  return new CloudflareRunDispatcher(parsed.toString(), token, fetchImpl);
}
