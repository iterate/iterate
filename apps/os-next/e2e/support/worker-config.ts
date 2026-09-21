// e2e/support/worker-config.ts — THE one place the e2e worker's config is built: read the generated
// wrangler.jsonc (scripts/generate-wrangler-config.ts, written by the build vitest.global-setup.ts
// runs) with wrangler's own reader, so the config is what wrangler sees — its top-level block, the
// local one — and patch it so the real project-worker runs under createTestHarness (local workerd,
// which bundles src/worker.ts itself). Shared by the e2e project's global-setup (the one worker every
// file speaks to), support/log-harness.ts (the second worker the console-reading file boots) and
// path-ingress.e2e.test.ts (a worker whose projects are paths on the one origin).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import type { IngressRouting } from "../../src/app-config.ts";

/** The package root (this file lives at e2e/support/). */
export const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The e2e worker's admin bearer — what the lane's default session authenticates with
 *  (support/client.ts `adminCredentials`; global-setup hands it to every file). */
export const E2E_ADMIN_API_SECRET = "e2e-admin-api-secret";
/** The e2e worker's sign-in password — what a browser session is minted with (support/principal.ts:
 *  `POST /login` with an email and this). */
export const E2E_LOGIN_PASSWORD = "e2e-password";
/** The local worker's ingress: project hosts hang under `localhost` (support/project-host.ts reaches
 *  them with a Host header). */
export const E2E_INGRESS_ROUTING: IngressRouting = { type: "subdomains", hostname: "localhost" };

/** wrangler.jsonc's top-level block patched for the harness: an absolute main, the e2e
 *  configuration, the deployments' `env` blocks left out. The directory D1 + OAuth KV are the local
 *  ones (a fresh namespace; the worker applies the schema at boot). The DO lifecycle is declarative
 *  (`exports`), so there is no migration history to replay. `ingressRouting` picks how this worker
 *  reaches projects — subdomains under `localhost` by default, paths for the file that proves that
 *  shape. */
export function e2eWorkerConfig(
  platformOrigin = "http://127.0.0.1",
  ingressRouting: IngressRouting = E2E_INGRESS_ROUTING,
): Unstable_RawConfig {
  const {
    rawConfig: { env: _deployments, ...rawConfig },
  } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  // Configuration (src/app-config.ts): the `APP_CONFIG_<PATH>__<KEY>` spellings of the one object —
  // the local block's vars replaced wholesale (a blank var is unset; a stale one would be warned
  // about), the secrets plain test values.
  const vars = Object.fromEntries(
    Object.entries(rawConfig.vars ?? {}).filter(([name]) => !name.startsWith("APP_CONFIG")),
  );
  return {
    ...rawConfig,
    main: join(PACKAGE_DIR, String(rawConfig.main)),
    // the issuer's pages (public/), an absolute directory like `main`
    assets: {
      ...rawConfig.assets,
      directory: join(PACKAGE_DIR, String(rawConfig.assets?.directory)),
    },
    vars: {
      ...vars,
      APP_CONFIG_URLS__OS: platformOrigin,
      ...(ingressRouting && { APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify(ingressRouting) }),
      // One custom hostname (a project's apex outside the base) for the ingress test that proves the
      // custom-hostname branch; the project it names is registered by that test.
      APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES: JSON.stringify({
        "custom-apex.test": "custom-apex-project",
      }),
      APP_CONFIG_LOGIN__PASSWORD: E2E_LOGIN_PASSWORD,
      APP_CONFIG_SECRETS__KEY: "e2e-secrets-key",
      APP_CONFIG_SECRETS__ADMIN_BEARER: E2E_ADMIN_API_SECRET,
    },
  };
}
