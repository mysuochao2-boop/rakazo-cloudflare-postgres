import { createPool } from "@rakazo/db";
import { objectStoreFromEnv } from "../object-store.js";
import { cloudflareDeploymentEnv, cloudflarePreflight } from "../preflight.js";

const result = cloudflarePreflight(process.env);
for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
if (result.errors.length > 0) {
  for (const error of result.errors) process.stderr.write(`error: ${error}\n`);
  process.exitCode = 1;
} else {
  await smoke(cloudflareDeploymentEnv(process.env));
  process.stdout.write("Cloudflare deployment smoke checks passed.\n");
}

async function smoke(env: NodeJS.ProcessEnv): Promise<void> {
  await checkPostgres(env.DATABASE_URL!, "API PostgreSQL");
  await checkPostgres(env.WORKER_DATABASE_URL!, "Worker PostgreSQL");

  const objectStore = objectStoreFromEnv(env);
  if (!objectStore) throw new Error("R2 configuration disappeared after preflight");
  await objectStore.objects.list(`${objectStore.prefix}/`);

  for (const path of ["/__edge/health", "/ready"]) {
    const response = await fetch(new URL(path, env.API_URL), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  }
}

async function checkPostgres(connectionString: string, label: string): Promise<void> {
  const pool = createPool(connectionString, { poolMax: 1, applicationName: "rakazo-preflight" });
  try {
    await pool.query("select 1");
  } catch (error) {
    throw new Error(`${label} connection failed`, { cause: error });
  } finally {
    await pool.end();
  }
}
