// Declaration-merge the first-party platform defaults into KnownCapabilities,
// so `itx.secrets` (via the fallthrough proxy) and `itx.capability("secrets")`
// type-check as their real cap surface instead of `unknown`. This is the
// compile-time mirror of PLATFORM_PROJECT_CAPABILITIES (platform-context.ts):
// every default that is a first-party loopback entrypoint gets its typed stub
// here. The runtime truth is always describe(); this is pure typing sugar.
//
// `Stubify<Pick<Cap, …>>` exposes ONLY the methods reachable over itx (each
// becomes async). Picking — rather than the whole class — keeps internal/
// platform-only methods (e.g. material-returning secret reads) off the itx
// surface, matching each capability's `call` allowlist.

import type { Stubify } from "./types.ts";
import type { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import type { ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import type { IntegrationsCapability } from "~/domains/secrets/entrypoints/integrations-capability.ts";
import type { AgentsCapability } from "~/domains/agents/entrypoints/agents-capability.ts";

declare module "./types.ts" {
  interface KnownCapabilities {
    secrets: Stubify<
      Pick<
        SecretsCapability,
        "setSecret" | "listSecrets" | "deleteSecret" | "getSecretSummaryByKey"
      >
    >;
    repos: Stubify<Pick<ReposCapability, "create" | "get" | "list" | "ensureProjectRepoInfo">>;
    integrations: Stubify<
      Pick<IntegrationsCapability, "getConnection" | "startOAuthFlow" | "disconnect">
    >;
    agents: Stubify<Pick<AgentsCapability, "sendMessage">>;
  }
}
