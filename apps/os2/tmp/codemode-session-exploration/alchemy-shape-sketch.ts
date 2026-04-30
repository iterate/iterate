/**
 * Alchemy wiring sketch for a tiny CodemodeSession worker.
 *
 * This is not meant to be imported. It shows the resource topology we want.
 */

import { D1Database, DurableObjectNamespace, Worker, WorkerLoader } from "alchemy/cloudflare";
import type { CodemodeSession } from "./session-api-sketch.ts";

declare const ctx: {
  workerName: string;
  compiledAppConfig: {
    eventsBaseUrl: string;
  };
};

const db = await D1Database("os-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

const codemodeSessionWorker = await Worker("codemode-session-do", {
  name: `${ctx.workerName}-codemode-session-do`,
  entrypoint: "./src/durable-objects/codemode-session.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    DO_CATALOG: db,
    EVENTS_BASE_URL: ctx.compiledAppConfig.eventsBaseUrl,
    LOADER: WorkerLoader(),
    CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>("codemode-session", {
      className: "CodemodeSession",
      sqlite: true,
    }),
  },
});

// Main os2 worker binding sketch:
const mainWorkerBindings = {
  DB: db,
  LOADER: WorkerLoader(),
  CODEMODE_SESSION: codemodeSessionWorker.bindings.CODEMODE_SESSION,
};

void mainWorkerBindings;
