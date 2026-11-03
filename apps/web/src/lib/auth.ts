import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof organizationClient>];
}> = createAuthClient({
  plugins: [organizationClient()],
  // Bound every auth request: an API container that accepts but never
  // answers (hung DB checkout, stalled forwarding hop) must fail fast into
  // the session gate's reconnect path, not leave useSession pending forever.
  fetchOptions: { timeout: 15_000 },
});
