export * from "./artifacts.js";
export * from "./home.js";
export * from "./migration.js";
export * from "./object-store.js";
export * from "./preflight.js";
export * from "./realtime.js";
export * from "./run-dispatcher.js";

import type { AgentHomeStore, ArtifactStore } from "@rakazo/adapter-kit";
import { R2ArtifactStore } from "./artifacts.js";
import { R2AgentHomeStore } from "./home.js";
import { objectStoreFromEnv } from "./object-store.js";

export function cloudflareFileStoresFromEnv(
  env: NodeJS.ProcessEnv,
): { home: AgentHomeStore; artifacts: ArtifactStore } | undefined {
  const selection = objectStoreFromEnv(env);
  if (!selection) return undefined;
  return {
    home: new R2AgentHomeStore(selection.objects, selection.prefix),
    artifacts: new R2ArtifactStore(selection.objects, selection.prefix),
  };
}
