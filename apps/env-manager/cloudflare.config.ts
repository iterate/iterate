import { bindings, defineWorker, exports } from "@cloudflare/vite-plugin/experimental-config";
import { envManagerEnv } from "../../envs.ts";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

/**
 * The manager deliberately has one deployment in the dev/preview account.
 * Importing envs.ts here makes the checked-in inventory the source of truth
 * for both the deployment and the environments compiled into the Worker.
 */
export default defineWorker({
  name: envManagerEnv.workerName,
  accountId: envManagerEnv.cloudflareAccountId,
  entrypoint,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: [
    "nodejs_compat",
    "nodejs_compat_populate_process_env",
    "global_fetch_strictly_public",
  ],
  workersDev: false,
  domains: [new URL(envManagerEnv.baseUrl).hostname],
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api/*"],
  },
  env: {
    APP_CONFIG_BASE_URL: bindings.text(envManagerEnv.baseUrl),
    APP_CONFIG_ITERATE_AUTH__ISSUER: bindings.text(`${envManagerEnv.authBaseUrl}/api/auth`),
    APP_CONFIG_ITERATE_AUTH__RESOURCE: bindings.text(envManagerEnv.baseUrl),
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: bindings.secret(),
    APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: bindings.secret(),
    APP_CONFIG_ITERATE_AUTH__JWKS: bindings.secret(),
    ENVIRONMENTS: bindings.durableObject({
      workerName: envManagerEnv.workerName,
      exportName: "EnvironmentDurableObject",
    }),
    PREVIEW_CLOUDFLARE_API_TOKEN: bindings.secretsStoreSecret(
      envManagerEnv.cloudflareApiTokenSecrets.preview,
    ),
    PRODUCTION_CLOUDFLARE_API_TOKEN: bindings.secretsStoreSecret(
      envManagerEnv.cloudflareApiTokenSecrets.production,
    ),
  },
  exports: {
    EnvironmentDurableObject: exports.durableObject({ storage: "sqlite" }),
  },
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: {
      enabled: true,
      invocationLogs: true,
      persist: true,
      headSamplingRate: 1,
    },
    traces: {
      enabled: true,
      persist: true,
      headSamplingRate: 1,
    },
  },
});
