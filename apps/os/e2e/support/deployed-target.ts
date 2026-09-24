// e2e/support/deployed-target.ts — a deployed worker under test, addressed by URL: the credentials
// come out of the deployment's own two secrets (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY` — in the
// environment under `doppler run`), its project routing and MCP origin out of the envs.ts entry the
// URL falls under, so a per-PR preview inherits its parent's. The vitest suite's global-setup and
// the root Playwright suite's specs/setup.ts both read it, each for its own workers.

import { osEnvs } from "../../../../envs.ts";
import { parseAppConfig } from "../../src/app-config.ts";

export function deployedTarget(workerBaseUrl: string): {
  adminApiSecret: string;
  loginPassword: string;
  /** JSON, as the specs and support/project-host.ts read it. */
  ingressRouting: string;
  mcpBaseUrl: string;
} {
  // The deployment's own object (src/app-config.ts), parsed the way the worker parses it — the two
  // secrets scripts/deploy.ts ships, nothing else in the environment.
  if (!process.env.APP_CONFIG)
    throw new Error(
      "APP_CONFIG unset — the deployed worker's own config, which holds the admin bearer (and the sign-in password, where it sets one) the e2e sessions use (run under `doppler run --project os --config <preview|prd>`)",
    );
  const appConfig = parseAppConfig({
    APP_CONFIG: process.env.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: process.env.APP_CONFIG_SECRETS__KEY,
  });
  const adminApiSecret = appConfig.secrets.adminBearer.exposeSecret();
  if (!adminApiSecret)
    throw new Error(
      "The deployment's APP_CONFIG sets no secrets.adminBearer — every e2e session authenticates with it",
    );
  // prd sets no password (nobody signs in there without proving their email); a test that signs in
  // with it fails at that sign-in (support/client.ts `loginPassword`), the operator-only ones run
  const loginPassword = appConfig.login.password.exposeSecret();
  // The envs.ts entry the worker falls under, by host suffix: `os.iterate.com` is prd's; a preview,
  // `pr<n>-os.<subdomain>.workers.dev`, hangs under its parent's host and
  // inherits the parent's routing.
  const host = new URL(workerBaseUrl).host;
  const env = Object.values(osEnvs).find((candidate) =>
    host.endsWith(new URL(candidate.baseUrl).host),
  );
  return {
    adminApiSecret,
    loginPassword,
    ingressRouting: JSON.stringify(env?.ingressRouting ?? null),
    // MCP on an origin of its own (prd's mcp.iterate.com) is the deployment's; on the platform
    // origin it is `/mcp` on the worker's own — a preview's, not its parent's.
    mcpBaseUrl:
      env && new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin
        ? env.mcpBaseUrl
        : new URL("/mcp", workerBaseUrl).href,
  };
}
