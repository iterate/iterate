// e2e/support/worker-config.ts — THE one place the e2e worker's config is built: read wrangler.jsonc
// (wrangler's own reader, so the config is what wrangler sees) and patch it so the real
// project-worker runs under createTestHarness (local workerd, production build hook). Shared by the
// e2e lane's global-setup (the one worker every file speaks to) and support/log-harness.ts (the
// second worker the console-reading file boots).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";

/** The package root (this file lives at e2e/support/). */
export const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The secret the e2e worker signs project tokens with (e2e/support/principal.ts mints with it). */
export const E2E_PROJECT_TOKEN_SECRET = "e2e-project-token-secret";

/** wrangler.jsonc patched for the harness: absolute main/build paths, the e2e configuration. The
 *  directory D1 + OAuth KV are inherited from wrangler.jsonc (a fresh local namespace; global-setup
 *  applies the schema). The DO lifecycle is declarative (`exports`), so there is no migration history
 *  to replay. */
export function e2eWorkerConfig(): Unstable_RawConfig {
  const { rawConfig } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return {
    ...rawConfig,
    main: join(PACKAGE_DIR, String(rawConfig.main)),
    assets: { ...rawConfig.assets, directory: join(PACKAGE_DIR, "public") },
    build: { ...rawConfig.build, cwd: PACKAGE_DIR },
    // Configuration (src/app-config.ts): the e2e lane is its own deployment name, and its project
    // hosts hang under `localhost` (support/project-host.ts reaches them with a Host header).
    vars: {
      ...rawConfig.vars,
      APP_CONFIG_ENVIRONMENT_NAME: "e2e",
      APP_CONFIG_PROJECT_HOSTNAME_BASE: "localhost",
      APP_CONFIG_PROJECT_TOKEN_SECRET: E2E_PROJECT_TOKEN_SECRET,
    },
  };
}
