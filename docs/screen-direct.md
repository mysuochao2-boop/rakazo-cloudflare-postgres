# Direct screen streaming (`RAKAZO_SCREEN_DIRECT`)

By default every noVNC frame goes browser → Cloudflare Worker (`/novnc/session/...`)
→ supervisor host. With the Docker supervisor on a VPS this adds a relay hop and the
Worker's websocket limits. `RAKAZO_SCREEN_DIRECT` lets the browser load noVNC from the
supervisor host itself (for example `https://computer.51proxy.org/direct/...`). The old
Worker path stays the default and the fallback.

## How it works

1. The API gets a provider screen URL such as
   `https://computer.51proxy.org/screen/<port>/embed.html?path=websockify?token=<provider token>`.
2. When the flag is on and the URL is a `/screen/<port>/embed.html` URL on
   `RAKAZO_SCREEN_DIRECT_ORIGIN`, the API seals `{port, websockify path+token, scope}`
   with AES-256-GCM (key `sha256("rakazo-screen-direct\0" + secret)`, AAD
   `direct:<policy>:<expiresAt>`) and returns
   `https://computer.51proxy.org/direct/<view|control>/<expiresAt>.<token>/embed.html?...&path=websockify`.
   The provider websockify token never reaches the browser. Anything else (terminal,
   other providers/hosts) keeps the `/novnc/session/` capability.
3. Nginx passes `/direct/` to the supervisor (`infra/nginx/computer-screen-direct.conf.example`).
4. The supervisor (`infra/sandboxes/supervisor/src/screen-direct.ts`):
   - opens the capability with `RAKAZO_SCREEN_DIRECT_SECRET` and rejects tampering,
     wrong policy and expired tokens;
   - only proxies to ports published by `rakazo.managed=true` containers;
   - serves static files with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
     `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors
     'self' <RAKAZO_SCREEN_DIRECT_FRAME_ANCESTORS>`; no CORS headers are sent;
   - accepts the websocket only from `RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS` (default:
     the `PUBLIC_SCREEN_BASE` origin, i.e. the noVNC page itself; `null` is refused),
     dials `websockify?token=<provider token>` on loopback and closes the tunnel when
     the capability expires.
5. Capabilities live 1 hour like the Worker ones; the API reuses a seal until 10
   minutes remain, and web/mobile renew in that window.

Web embeds `/direct/` iframes with `sandbox="allow-scripts allow-same-origin
allow-pointer-lock"` (cross-origin only), so the websocket carries a real Origin.
Mobile treats `/direct/` like `/novnc/session/` for stream identity and renewal.

## Configuration

API (Cloudflare: `CONTAINER_ENV_JSON`):

| Variable | Meaning |
| --- | --- |
| `RAKAZO_SCREEN_DIRECT` | `1`/`true` to issue direct URLs. Default off. |
| `RAKAZO_SCREEN_DIRECT_SECRET` | 32+ chars, shared with the supervisor only. Not the `SCREEN_PROXY_SECRET`. |
| `RAKAZO_SCREEN_DIRECT_ORIGIN` | `https://computer.51proxy.org` (must equal `PUBLIC_SCREEN_BASE`). |

If the flag is on but secret/origin are invalid the API logs a warning and keeps the
Worker path.

Supervisor (`infra/compose/.env.supervisor`):

| Variable | Meaning |
| --- | --- |
| `RAKAZO_SCREEN_DIRECT_SECRET` | Same value as the API. Empty disables `/direct/` (404). |
| `RAKAZO_SCREEN_DIRECT_FRAME_ANCESTORS` | Origins allowed to iframe the screen, e.g. `https://bot.51proxy.org`. |
| `RAKAZO_SCREEN_DIRECT_ALLOWED_ORIGINS` | Optional websocket Origin allowlist; default `PUBLIC_SCREEN_BASE`. |

Generate the secret with `openssl rand -base64 48`.

## Rollout order

1. Supervisor first: set the two supervisor variables, rebuild/restart the supervisor.
   With the API flag still off nothing changes for users.
2. Add the Nginx `location ^~ /direct/` block, `nginx -t`, reload.
3. Turn on the API flag (with secret + origin) and bump the API generation.

## Rollback

Set `RAKAZO_SCREEN_DIRECT=0` (or remove it) in the API env and bump the generation:
new screen URLs go back to `/novnc/session/`. Open direct streams end at their 1h
expiry, or immediately when the supervisor secret is removed and it is restarted.

## Security notes and limits

- The Worker path re-checks the database every second (bot/computer generation,
  control lease) and cuts streams on revocation. The direct path cannot query the
  database; it relies on the provider tokens in the seal (control release stops the
  control x11vnc; screen resets rotate websockify tokens) and on the 1h expiry. A
  leaked direct URL is usable for the rest of its hour while the underlying screen
  token is unchanged.
- The token is in the URL path. Keep `access_log off` for `/direct/` and the
  `no-referrer` policy.
