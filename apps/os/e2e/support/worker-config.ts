// Read Vite's built Worker config with Wrangler's parser and patch it for createTestHarness.
// Shared by the E2E global setup and support/own-worker.ts.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import type { IngressRouting } from "iterate/next/project-ingress";

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
export const E2E_INGRESS_ROUTING: NonNullable<IngressRouting> = {
  type: "subdomains",
  hostname: "localhost",
};

/** Vite's local built config patched with absolute paths and test credentials. The control-plane
 *  Durable Object and OAuth KV remain local. `ingressRouting` chooses subdomains or paths for project requests. */
export function e2eWorkerConfig(
  platformOrigin = "http://127.0.0.1",
  ingressRouting: NonNullable<IngressRouting> = E2E_INGRESS_ROUTING,
): Unstable_RawConfig {
  const {
    rawConfig: { env: _deployments, ...rawConfig },
  } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "dist/server/wrangler.json") });
  if (rawConfig.name !== "os-local-build")
    throw new Error(
      `local e2e needs a local Vite build (found ${rawConfig.name}); run pnpm e2e to rebuild first`,
    );
  // Configuration (src/app-config.ts): the `APP_CONFIG_<PATH>__<KEY>` spellings of the one object —
  // the local block's vars replaced wholesale (a blank var is unset; a stale one would be warned
  // about), the secrets plain test values.
  const vars = Object.fromEntries(
    Object.entries(rawConfig.vars ?? {}).filter(([name]) => !name.startsWith("APP_CONFIG")),
  );
  return {
    ...rawConfig,
    main: join(PACKAGE_DIR, "dist/server", String(rawConfig.main)),
    // the issuer's pages (public/), an absolute directory like `main`
    assets: {
      ...rawConfig.assets,
      directory: join(PACKAGE_DIR, "dist/server", String(rawConfig.assets?.directory)),
    },
    vars: {
      ...vars,
      APP_CONFIG_URLS__OS: platformOrigin,
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify(ingressRouting),
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
