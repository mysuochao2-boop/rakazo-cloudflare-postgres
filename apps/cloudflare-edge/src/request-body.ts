export type LimitedBody = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 };

export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, status: 400 };
    if (length > maxBytes) return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readJsonWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const body = await readBodyWithLimit(request, maxBytes);
  if (!body.ok) return body;
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)),
    };
  } catch {
    return { ok: false, status: 400 };
  }
}
