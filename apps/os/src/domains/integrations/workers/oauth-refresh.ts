// Builds the ref that installs the shared OAuth refresh worker
// (oauth-refresh.worker.js) on a connection secret. The worker source is a real
// .js file imported verbatim (`?raw`, typed by vite/client) rather than a
// template-literal blob — lint/format-clean and immune to the editor NUL-byte
// artifact that bit the inline sources. Parametrized entirely by props, so one
// source serves every OAuth-refresh integration (Google, petshop userspace, …).
import oauthRefreshWorkerSource from "./oauth-refresh.worker.js?raw";
import type { StatelessDynamicWorkerRef } from "../../../types.ts";

/**
 * A connection-secret worker that refreshes an OAuth access token on 401.
 *
 * @param tokenUrl      the provider's token endpoint (refresh_token grant).
 * @param appSecretPath the app-tier secret whose `basicAuth` field the refresh
 *   rides as a header placeholder — a `/secrets/platform/**` path for
 *   first-party, or a userspace `/secrets/integrations/<slug>` for BYO-client.
 */
export function oauthRefreshWorkerRef(input: {
  appSecretPath: string;
  tokenUrl: string;
}): StatelessDynamicWorkerRef {
  return {
    type: "stateless",
    path: "/",
    props: { appSecretPath: input.appSecretPath, tokenUrl: input.tokenUrl },
    source: {
      files: { type: "inline", files: { "worker.js": oauthRefreshWorkerSource } },
      options: { bundle: false, entryPoint: "worker.js" },
    },
  };
}
