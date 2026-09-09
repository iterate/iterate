// e2e/support/global-setup.ts — boots the REAL project-worker ONCE for the whole vitest E2E run
// (the apps/os shape: one worker, addressed by URL, shared by every file — no per-file boot). It
// builds through the production build hook, runs in local workerd with local KV / D1 / Durable
// Objects / the Worker Loader, and tests speak to it EXACTLY like production clients — capnweb over
// WebSocket at /api. The control plane is in-process (worker.ts's catch-all), so nothing else boots.
//
// The URL is handed to tests via vitest `provide`/`inject` (see support/setup.ts + support/client.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestHarness } from "wrangler";
import type { TestProject } from "vitest/node";
import { e2eWorkerConfig, PACKAGE_DIR } from "./worker-config.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** Base URL of the one E2E worker, e.g. http://127.0.0.1:1234 — every test opens capnweb here. */
    workerBaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // DEPLOYED-TARGET MODE — the proof that counts: `WORKER_BASE_URL=https://project-worker.<sub>.workers.dev
  // pnpm e2e` runs the SAME suite against the deployed worker, no local boot.
  const deployedWorkerBaseUrl = process.env.WORKER_BASE_URL;
  if (deployedWorkerBaseUrl) {
    project.provide("workerBaseUrl", deployedWorkerBaseUrl);
    return async () => {};
  }
  const server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [{ config: e2eWorkerConfig() }],
  });
  const { url } = await server.listen();
  // THE DIRECTORY SCHEMA into the local D1 the harness bound — applied through the worker's OWN binding
  // (`getEnv().DB`), so it lands in exactly the namespace the worker reads (a separate `wrangler d1
  // execute --local` persists elsewhere). control-plane.sql is the one source (idempotent: IF NOT EXISTS),
  // read from disk here; no schema code lives in the worker. D1's exec() is line-oriented, so each
  // `;`-terminated statement is collapsed to one line and run as a prepared batch.
  const { DB } = await server.getWorker<{ DB: D1Database }>().getEnv();
  const statements = readFileSync(join(PACKAGE_DIR, "src/control-plane.sql"), "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  await DB.batch(statements.map((statement) => DB.prepare(statement)));
  project.provide("workerBaseUrl", url.href);
  return async () => {
    await server.close();
  };
}
