import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { migrateLocalFiles } from "../migration.js";
import { createObjectStore, objectStoreConfigFromEnv } from "../object-store.js";

loadRootEnv();

const config = objectStoreConfigFromEnv(process.env);
if (!config) throw new Error("Object store configuration is required");
const apply = process.argv.includes("--apply");
const result = await migrateLocalFiles({
  dataDir: process.env.DATA_DIR ?? "./data",
  objects: createObjectStore(config),
  prefix: config.prefix,
  apply,
});

process.stdout.write(
  `${apply ? "Migrated" : "Would migrate"} ${result.homes} homes and ${result.artifacts} artifacts (${result.artifactBytes} bytes).\n`,
);
