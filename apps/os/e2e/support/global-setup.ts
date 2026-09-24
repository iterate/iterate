// e2e/support/global-setup.ts — boots the REAL worker ONCE for the whole vitest E2E run
// (one worker, addressed by URL, shared by every file — no per-file boot). It
// builds through the production build hook, runs in local workerd with local KV / Durable
// Objects / the Worker Loader, and tests speak to it EXACTLY like production clients — capnweb over
// WebSocket at /api. The control plane is in-process (worker.ts's catch-all), so nothing else boots;
// its database is the `CONTROL_PLANE` singleton DO's own SQLite (src/control-plane/).
//
// The URL is handed to tests via vitest `provide`/`inject` (see support/setup.ts + support/client.ts).

import { randomUUID } from "node:crypto";
import { createTestHarness } from "wrangler";
import type { TestProject } from "vitest/node";
import { deployedTarget } from "./deployed-target.ts";
import {
  E2E_ADMIN_API_SECRET,
  E2E_INGRESS_ROUTING,
  E2E_LOGIN_PASSWORD,
  e2eWorkerConfig,
  PACKAGE_DIR,
} from "./worker-config.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** Base URL of the one E2E worker, e.g. http://127.0.0.1:1234 — every test opens capnweb here. */
    workerBaseUrl: string;
    /** The worker's admin bearer — what the lane's default session authenticates with
     *  (support/client.ts): the local worker's (worker-config.ts), a deployed worker's
     *  `secrets.adminBearer` handed to the run as ADMIN_API_SECRET (never in the tree). */
    adminApiSecret: string;
    /** The worker's sign-in password — what support/principal.ts mints a browser session with: the
     *  local worker's (worker-config.ts), a deployed worker's `login.password` handed to the run as
     *  LOGIN_PASSWORD (never in the tree). */
    loginPassword: string;
    /** How the worker reaches projects (src/app-config.ts `urls.ingressRouting`), as JSON: subdomains
     *  under `localhost` for the local worker, the deployed worker's routing otherwise. Injected into
     *  the worker thread's env so support/project-host.ts reads it (vitest worker threads do NOT
     *  inherit the run's process.env). */
    ingressRouting: string;
    /** Where MCP's protocol endpoint lives — the deployed worker's `urls.mcp` when it serves MCP on
     *  its own origin, else `<worker>/mcp` (the local worker, and any deploy without a distinct MCP
     *  origin). support/session tests POST here. */
    mcpBaseUrl: string;
    /** The run's id, folded into every identifier a test mints (client.ts `freshCtx`): E2E_RUN_ID
     *  when the run pins one (CI: the workflow run and attempt), else minted here once per run. */
    runId: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  project.provide("runId", process.env.E2E_RUN_ID || randomUUID().slice(0, 8));
  // DEPLOYED-TARGET MODE — the proof that counts: `WORKER_BASE_URL=https://os.iterate.com pnpm e2e`
  // runs the SAME suite against the deployed worker, no local boot. Its credentials and routing come
  // from the deployment's APP_CONFIG in the environment (`doppler run`) and its envs.ts entry, or
  // from an explicit ADMIN_API_SECRET / LOGIN_PASSWORD (support/deployed-target.ts).
  const deployedWorkerBaseUrl = process.env.WORKER_BASE_URL;
  if (deployedWorkerBaseUrl) {
    const target = deployedTarget(deployedWorkerBaseUrl);
    project.provide("workerBaseUrl", deployedWorkerBaseUrl);
    project.provide("adminApiSecret", target.adminApiSecret);
    project.provide("loginPassword", target.loginPassword);
    project.provide("ingressRouting", target.ingressRouting);
    project.provide("mcpBaseUrl", target.mcpBaseUrl);
    return async () => {};
  }
  const server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [{ config: e2eWorkerConfig() }],
  });
  const { url } = await server.listen();
  await server.update({ root: PACKAGE_DIR, workers: [{ config: e2eWorkerConfig(url.origin) }] });
  project.provide("workerBaseUrl", url.href);
  project.provide("adminApiSecret", E2E_ADMIN_API_SECRET);
  project.provide("loginPassword", E2E_LOGIN_PASSWORD);
  // The local worker's project hosts hang under `localhost` (worker-config.ts) and it serves MCP at
  // `/mcp` (no distinct MCP origin).
  project.provide("ingressRouting", JSON.stringify(E2E_INGRESS_ROUTING));
  project.provide("mcpBaseUrl", new URL("/mcp", url.href).href);
  return async () => {
    await server.close();
  };
}
