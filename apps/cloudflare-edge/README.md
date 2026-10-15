# Cloudflare deployment profile

This profile runs Rakazo's bot runtime on Cloudflare with one external PostgreSQL service. It keeps
Prisma, Graphile Worker, PostgreSQL locks, the provider-neutral sandbox boundary, and all existing
web, Electron, and mobile API contracts intact. Local and self-hosted adapters remain available in
the other deployment profiles.

## Implementation status

The code migration stages are complete: edge routing and Container lifecycle, scheduler/bot split,
R2 homes and artifacts with a backfill CLI, Durable Object realtime fanout, bounded authenticated
internal routes, static preflight, live smoke checks, and the cutover/rollback runbook. Production
credentials remain environment-managed and are never stored in this repository. Staged
end-to-end acceptance remains deployment-environment work.

## Services

- `ApiContainer`: a stateless pool that runs `@rakazo/api`.
- `SchedulerContainer`: runs Graphile consumption, reconciliation, and dispatch only.
- `BotRuntimeContainer`: one Durable Object-named Container per active bot, started on demand and
  stopped after inactivity.
- `ComputerContainer`: one Durable Object-named graphical Container per Computer record. Team mode
  shares it across a Space with isolated Bot displays and browser profiles; dedicated mode gives a
  Bot its own Computer.
- `RealtimeHub`: a hibernating WebSocket Durable Object for inter-Container realtime fanout.
- R2: durable agent homes and artifacts through the generic object-store adapter.
- The edge Worker authenticates internal routes, routes API traffic, and wakes Scheduler Containers
  every five minutes.

All Containers connect to external PostgreSQL over TLS. `DATABASE_URL` should be transaction-pooled
for API and bot Containers. `WORKER_DATABASE_URL` must be direct or session-pooled because Graphile,
LISTEN, and advisory leadership locks require session affinity. `REALTIME_DATABASE_URL` is an
optional fallback used outside the Durable Object fanout profile.

## Required configuration

Replace the placeholder URLs in `wrangler.jsonc`, then create secrets without adding their values to
the repository:

```sh
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put DATABASE_URL
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put WORKER_DATABASE_URL
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put REALTIME_DATABASE_URL
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put ENCRYPTION_KEY
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put SCREEN_PROXY_SECRET
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put RUNTIME_DISPATCH_SECRET
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put REALTIME_FANOUT_SECRET
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put OBJECT_STORE_GATEWAY_SECRET
pnpm --filter @rakazo/cloudflare-edge exec wrangler secret put COMPUTER_GATEWAY_SECRET
```

Optional settings are supplied as a JSON object in the `CONTAINER_ENV_JSON` Worker secret. Values
must be strings. Use it for existing generic provider settings such as `SANDBOX_PROVIDER` and model
connection settings. The Cloudflare production profile always uses the Pi model runtime;
`AGENT_RUNTIME` and required database and encryption settings cannot be overridden through this
JSON object.

The Cloudflare profile binds R2 directly to the edge Worker. API, Scheduler, and bot Containers use
the authenticated `__objects` gateway injected by the Worker, so the default deployment does not
need R2 access keys or an S3 endpoint in `CONTAINER_ENV_JSON`. `OBJECT_STORE_GATEWAY_SECRET` must be
an independent random value. The generic S3-compatible settings (`OBJECT_STORE_ENDPOINT`,
`OBJECT_STORE_BUCKET`, `OBJECT_STORE_ACCESS_KEY_ID`, and `OBJECT_STORE_SECRET_ACCESS_KEY`) remain
available for release tools and deployment profiles that run outside the Worker gateway.

The profile defaults to `SANDBOX_PROVIDER=cloudflare` inside API, Scheduler, and bot Containers.
`CONTAINER_ENV_JSON` may override it to a supported provider such as `docker` for Hybrid setups
that point `SANDBOX_SUPERVISOR_URL` / `SANDBOX_SUPERVISOR_TOKEN` at a remote supervisor (for example
`https://computer.example`). Do not switch production until home-path and noVNC allowlist staging
passes. The Worker injects the authenticated Cloudflare Computer gateway for the default provider;
do not add `COMPUTER_GATEWAY_SECRET` to `CONTAINER_ENV_JSON`. For Hybrid noVNC, set Worker var
`SCREEN_UPSTREAM_ALLOWLIST` to the comma-separated upstream hostnames the edge proxy may fetch
(and mirror the same value into `CONTAINER_ENV_JSON` so API screen sealing accepts http upstreams).
`COMPUTER_GATEWAY_SECRET` must be independent from every other internal secret.

The profile routes inter-Container realtime signals through a hibernating Durable Object. Existing
client SSE contracts remain unchanged; API Containers subscribe to the Durable Object and continue
serving the current thread subscription endpoints.

Before migration or deployment, expose the same values to the release environment and run the
static configuration audit. It validates both PostgreSQL endpoints, independent internal secrets,
R2, HTTPS origins, and a supported remote sandbox without printing secret values:

```sh
pnpm cloudflare:preflight
```

Run PostgreSQL migrations as a separate release step before deploying new application images:

```sh
DATABASE_URL='<external-postgres-url>' pnpm db:migrate
pnpm cloudflare:deploy
```

For a Worker-only change that intentionally keeps the currently deployed Container images, avoid a
redundant image build and rollout:

```sh
pnpm --filter @rakazo/cloudflare-edge exec wrangler deploy --containers-rollout none
```

After deployment, run live connectivity checks from an environment holding the same configuration.
This performs read-only PostgreSQL queries, lists the configured R2 prefix, and calls edge/API
readiness endpoints:

```sh
pnpm cloudflare:smoke
```

Backfill an existing local deployment into R2 with a dry run first. The command preserves existing
artifact IDs and verifies uploaded bytes before reporting success:

```sh
pnpm --filter @rakazo/adapters-cloudflare migrate:files
pnpm --filter @rakazo/adapters-cloudflare migrate:files -- --apply
```

## Local verification

Cloudflare Container development requires a running Docker-compatible daemon:

```sh
pnpm cloudflare:types
pnpm --filter @rakazo/cloudflare-edge check
pnpm --filter @rakazo/cloudflare-edge test
pnpm --filter @rakazo/adapters-cloudflare test
pnpm cloudflare:preflight
pnpm cloudflare:dev
```

The unit and configuration checks do not replace staging acceptance. A real Cloudflare account,
external PostgreSQL endpoint, R2 bucket, and remote sandbox credentials are required to execute the
nine staging checks in `MIGRATION.md`. Building or running Containers locally also requires a
Docker-compatible daemon.
