// e2e/support/worker-config.ts — THE one place the e2e worker's config is built: read the generated
// wrangler.jsonc (scripts/generate-wrangler-config.ts, written by the build vitest.global-setup.ts
// runs) with wrangler's own reader, so the config is what wrangler sees — its top-level block, the
// local one — and patch it so the real project-worker runs under createTestHarness (local workerd,
// which bundles src/worker.ts itself). Shared by the e2e project's global-setup (the one worker every
// file speaks to) and support/log-harness.ts (the second worker the console-reading file boots).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";

/** The package root (this file lives at e2e/support/). */
export const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The e2e worker's admin secret — what the lane's default session authenticates with
 *  (support/client.ts `adminCredentials`; global-setup hands it to every file). */
export const E2E_ADMIN_API_SECRET = "e2e-admin-api-secret";

/** wrangler.jsonc's top-level block patched for the harness: an absolute main, the e2e
 *  configuration, the deployments' `env` blocks left out. The directory D1 + OAuth KV are the local
 *  ones (a fresh namespace; global-setup applies the schema). The DO lifecycle is declarative
 *  (`exports`), so there is no migration history to replay. */
export function e2eWorkerConfig(platformOrigin = "http://127.0.0.1"): Unstable_RawConfig {
  const {
    rawConfig: { env: _deployments, ...rawConfig },
  } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return {
    ...rawConfig,
    main: join(PACKAGE_DIR, String(rawConfig.main)),
    // the issuer's pages (public/), an absolute directory like `main`
    assets: {
      ...rawConfig.assets,
      directory: join(PACKAGE_DIR, String(rawConfig.assets?.directory)),
    },
    // Configuration (src/worker.ts `parseAppConfig`): the e2e lane is its own deployment name, its project
    // hosts hang under `localhost` (support/project-host.ts reaches them with a Host header), and the
    // two secrets a deployment keeps in wrangler are plain test values here.
    vars: {
      ...rawConfig.vars,
      APP_CONFIG_ENVIRONMENT_NAME: "e2e",
      APP_CONFIG_PLATFORM_ORIGIN: platformOrigin,
      APP_CONFIG_MCP_ORIGIN: "",
      APP_CONFIG_PROJECT_HOSTNAME_BASE: "localhost",
      // One custom hostname (a project's apex outside the base) for the ingress test that proves the
      // custom-hostname branch; the project it names is registered by that test.
      APP_CONFIG_PROJECT_CUSTOM_HOSTNAMES: "custom-apex.test=custom-apex-project",
      APP_CONFIG_SESSION_SECRET: "e2e-session-secret",
      APP_CONFIG_SECRETS_KEY: "e2e-secrets-key",
      APP_CONFIG_ADMIN_API_SECRET: E2E_ADMIN_API_SECRET,
    },
  };
}
