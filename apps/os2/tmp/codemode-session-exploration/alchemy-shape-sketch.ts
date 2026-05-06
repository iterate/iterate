/**
 * Alchemy wiring sketch for a tiny CodemodeSession worker.
 *
 * This is not meant to be imported. It shows the resource topology we want.
 */

import { D1Database, DurableObjectNamespace, Worker, WorkerLoader } from "alchemy/cloudflare";
import type { CodemodeSession } from "./session-api-sketch.ts";

declare const ctx: {
  workerName: string;
};

declare const deploymentConfig: {
  streamDurableObjectBindingScriptName: string;
};

declare class StreamDurableObject {
  initialize(input: { name: string; projectId: string; streamPath: string }): Promise<unknown>;
}

const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  scriptName: deploymentConfig.streamDurableObjectBindingScriptName,
});

type Env = {
  STREAM: {
    getByName(name: string): {
      append(input: unknown): Promise<unknown>;
      initialize(input: { name: string; projectId: string; streamPath: string }): Promise<unknown>;
    };
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
    LOADER: WorkerLoader(),
    STREAM: stream,
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
  STREAM: stream,
  CODEMODE_SESSION: codemodeSessionWorker.bindings.CODEMODE_SESSION,
};

void ({} as Env);
void mainWorkerBindings;
