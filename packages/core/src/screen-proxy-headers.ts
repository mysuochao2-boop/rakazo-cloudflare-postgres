export const SENSITIVE_SCREEN_RESPONSE_HEADERS = new Set([
  "clear-site-data",
  "set-cookie",
  "set-cookie2",
]);
const SCREEN_SANDBOX = "sandbox allow-scripts allow-pointer-lock";
type ScreenHeaders = Record<string, string | string[] | undefined>;

/** Shared by the Node and edge proxies; viewers remain opaque even outside an iframe. */
export function safeScreenProxyResponseHeaders(headers: ScreenHeaders): ScreenHeaders {
  const safe: ScreenHeaders = {};
  const policies: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (value == null || name.startsWith(":") || SENSITIVE_SCREEN_RESPONSE_HEADERS.has(name))
      continue;
    if (name === "content-security-policy") {
      policies.push(...(Array.isArray(value) ? value : [value]));
    } else {
      safe[name] = value;
    }
  }
  // Separate policies intersect: an upstream allow-same-origin cannot relax
  // the sandbox, and provider restrictions (including frame-ancestors) remain.
  safe["content-security-policy"] = [...policies, SCREEN_SANDBOX];
  // Module imports from the opaque iframe origin need CORS, but no cookies.
  safe["access-control-allow-origin"] = "*";
  delete safe["access-control-allow-credentials"];
  return safe;
}
