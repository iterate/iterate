// Builds the ref that installs the GitHub App installation-token worker
// (github-install.worker.js) on a connection secret. Source imported verbatim
// (`?raw`) — lint/format-clean, NUL-proof. Parametrized by props.
import type { StatelessDynamicWorkerRef } from "../../../types.ts";
import githubInstallWorkerSource from "./github-install.worker.js?raw";

/**
 * A connection-secret worker that mints/refreshes a GitHub installation token
 * by signing an App JWT (ADR 0006).
 *
 * @param apiBase       GitHub API origin (real `https://api.github.com`, or a
 *   stand-in in tests).
 * @param appId         the App's id — the JWT `iss` (public, not a secret).
 * @param appSecretPath the app-tier secret whose `privateKey` field `env.APP`
 *   signs with — a userspace `/secrets/integrations/<slug>` (bring-your-own
 *   App) or `/secrets/platform/integrations/github` (first-party).
 */
export function githubInstallWorkerRef(input: {
  apiBase: string;
  appId: string;
  appSecretPath: string;
}): StatelessDynamicWorkerRef {
  return {
    type: "stateless",
    path: "/",
    props: { apiBase: input.apiBase, appId: input.appId, appSecretPath: input.appSecretPath },
    source: {
      files: { type: "inline", files: { "worker.js": githubInstallWorkerSource } },
      options: { bundle: false, entryPoint: "worker.js" },
    },
  };
}
