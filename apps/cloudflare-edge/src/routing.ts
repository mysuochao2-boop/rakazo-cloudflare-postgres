export function replicaCount(value: string, label: string, maximum: number): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return count;
}

export function requestReplica(request: Request, count: number): number {
  const url = new URL(request.url);
  const input =
    request.headers.get("x-rakazo-routing-key") ??
    request.headers.get("cf-connecting-ip") ??
    `${request.method}:${url.pathname}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}
