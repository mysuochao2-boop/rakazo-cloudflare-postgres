import { SENSITIVE_SCREEN_RESPONSE_HEADERS } from "../screen-proxy-headers.ts";

export { safeScreenProxyResponseHeaders } from "../screen-proxy-headers.ts";

export function stripSensitiveHandshakeHeaders(response: Buffer) {
  const end = response.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const lines = response.subarray(0, end).toString("latin1").split("\r\n");
  const safeLines = lines.filter((line, index) => {
    if (index === 0) return true;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    return !SENSITIVE_SCREEN_RESPONSE_HEADERS.has(name.trim().toLowerCase());
  });
  return Buffer.concat([
    Buffer.from(`${safeLines.join("\r\n")}\r\n\r\n`, "latin1"),
    response.subarray(end + 4),
  ]);
}
