// e2e/support/deployed-target.ts — a deployed worker under test, addressed by URL: the credentials
// come out of the deployment's own two secrets (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY` — in the
// environment under `doppler run`), its project routing and MCP origin out of the envs.ts entry the
// URL falls under, so a per-PR preview inherits its parent's. An explicit ADMIN_API_SECRET,
// LOGIN_PASSWORD, PROJECT_INGRESS_ROUTING or MCP_BASE_URL still wins. The vitest suite's
// global-setup and playwright.config.ts both read it, each for its own worker processes.

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
  const appConfig =
    !(process.env.ADMIN_API_SECRET && process.env.LOGIN_PASSWORD) && process.env.APP_CONFIG
      ? parseAppConfig({
          APP_CONFIG: process.env.APP_CONFIG,
          APP_CONFIG_SECRETS__KEY: process.env.APP_CONFIG_SECRETS__KEY,
        })
      : undefined;
  const adminApiSecret =
    process.env.ADMIN_API_SECRET || appConfig?.secrets.adminBearer.exposeSecret();
  if (!adminApiSecret)
    throw new Error(
      "ADMIN_API_SECRET unset — the deployed worker's secrets.adminBearer, which every e2e session authenticates with (hand it over, or run under `doppler run` so APP_CONFIG is in the environment)",
    );
  const loginPassword = process.env.LOGIN_PASSWORD || appConfig?.login.password.exposeSecret();
  if (!loginPassword)
    throw new Error(
      "LOGIN_PASSWORD unset — the deployed worker's login.password, which the e2e browser sessions sign in with (hand it over, or run under `doppler run` so APP_CONFIG is in the environment)",
    );
  // The envs.ts entry the worker falls under, by host suffix: `os.iterate.com` is prd's; a preview,
  // `pr<n>-<slug>-os-next-preview.<subdomain>.workers.dev`, hangs under its parent's host and
  // inherits the parent's routing.
  const host = new URL(workerBaseUrl).host;
  const env = Object.values(osEnvs).find((candidate) =>
    host.endsWith(new URL(candidate.baseUrl).host),
  );
  return {
    adminApiSecret,
    loginPassword,
    ingressRouting:
      process.env.PROJECT_INGRESS_ROUTING || JSON.stringify(env?.ingressRouting ?? null),
    // MCP on an origin of its own (prd's mcp.iterate.com) is the deployment's; on the platform
    // origin it is `/mcp` on the worker's own — a preview's, not its parent's.
    mcpBaseUrl:
      process.env.MCP_BASE_URL ||
      (env && new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin
        ? env.mcpBaseUrl
        : new URL("/mcp", workerBaseUrl).href),
  };
}
