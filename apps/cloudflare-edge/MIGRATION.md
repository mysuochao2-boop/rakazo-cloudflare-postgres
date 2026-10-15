# External PostgreSQL + Cloudflare migration runbook

## Final topology

- External PostgreSQL remains the relational source of truth and Graphile job store.
- API and Scheduler run in default-policy Cloudflare Containers.
- Each active bot runs in a Durable Object-managed Container.
- R2 stores agent homes and artifacts through the edge Worker's authenticated object gateway.
- A hibernating Durable Object distributes realtime signals between Containers.
- Computer runtimes remain remote `SandboxProvider` implementations.

## 1. Prepare PostgreSQL

Create separate connection endpoints where the provider supports them:

- `DATABASE_URL`: pooled endpoint for API and bot runtime Containers.
- `WORKER_DATABASE_URL`: direct or session-pooled endpoint for Graphile and advisory leadership locks.

Require TLS certificate verification, backups, point-in-time recovery, and enough client capacity for:

```text
API replicas × DB_POOL_MAX
+ Scheduler replicas × DB_POOL_MAX
+ active bot Containers
+ administration reserve
```

Run `pnpm db:migrate` from a release job before deploying application images. Do not run migrations
independently in every API replica.

## 2. Prepare R2

Create one private bucket, bind it to `OBJECT_STORE`, and set an independent
`OBJECT_STORE_GATEWAY_SECRET`. Containers receive the gateway URL and bearer secret from the edge
Worker; do not add R2 access keys to their environment. Release tools running outside Cloudflare may
instead use bucket-scoped `OBJECT_STORE_*` S3 credentials. Run the file migration without `--apply`,
inspect the totals, then run it with `--apply`. The migration is additive and does not delete local
files.

Keep the old file store read-only until post-cutover hash and restore checks pass. Do not enable the
object-store variables before the backfill has completed.

## 3. Configure Cloudflare secrets

Set the required secrets listed in `README.md`. Use independently generated values for
`RUNTIME_DISPATCH_SECRET`, `REALTIME_FANOUT_SECRET`, `OBJECT_STORE_GATEWAY_SECRET`, and
`COMPUTER_GATEWAY_SECRET`. Never place their values in Wrangler vars, image layers, source files,
or build logs.

The Cloudflare profile selects its built-in `cloudflare` Computer provider. `docker` remains a
Compose-only provider and is not valid for this profile.

Run `pnpm cloudflare:preflight` in the release environment before applying migrations. Treat any
reported error as a deployment blocker; review TLS warnings against the PostgreSQL provider's
connection-string format.

## 4. Stage Containers

Deploy to a staging Worker and verify:

1. `/__edge/health` succeeds.
2. Both Scheduler Containers remain healthy across two cron intervals.
3. API readiness succeeds and PostgreSQL connection counts stay within budget.
4. A test Run is dispatched to a bot Container and completes exactly once.
5. Killing the bot Container causes the expired database lease to be reconciled and resumed.
6. Agent home changes and artifacts survive Container destruction.
7. Two API Containers receive the same realtime signal through the Durable Object.
8. A bot waiting for user input scales down and resumes from PostgreSQL/R2 state.
9. A Team Computer gives two Bots distinct displays and browser profiles, and its noVNC capability
   cannot address a different Computer.

Run `pnpm cloudflare:smoke` for the automatable PostgreSQL, R2, edge, and API checks. The Run crash,
resume, realtime cross-replica, and Container destruction scenarios still require the staged
end-to-end exercise above.

The database lease and the existing 30-second reconciler are the crash-recovery source of truth.
The Durable Object completion callback only shortens the Container inactivity window; losing that
callback does not mark a Run complete or prevent lease-based redispatch.

## 5. Production cutover

Route cohorts by Space at the upstream DNS/traffic layer:

```text
internal → new Spaces → 1% → 10% → 50% → 100%
```

At every gate monitor PostgreSQL connections, Graphile queue age, bot cold starts, run lease expiry,
duplicate external effects, R2 errors, and Container restarts. Stop advancement if any invariant
regresses.

## 6. Rollback

PostgreSQL remains the shared source of truth, so rollback routes traffic to the previous API and
Worker deployment. Before rollback:

1. Stop new Cloudflare dispatches.
2. Allow active bot Containers to checkpoint or cancel their leases.
3. Keep R2 enabled in the previous deployment, or restore the final R2 home revisions to its local
   store before accepting writes.
4. Resume Graphile consumers only after Cloudflare Scheduler Containers are stopped.

Never run the old Worker and Cloudflare Scheduler with different runtime-dispatch policies against
the same Graphile queue during a rollback.
