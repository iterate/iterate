import type { Client } from "sqlfu";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { auth } from "@clerk/tanstack-react-start/server";
import manifest, { type AppConfig } from "~/app.ts";
import type { CodemodeSession } from "~/durable-objects/codemode-session.ts";
import type { ProjectDurableObject } from "~/durable-objects/project-durable-object.ts";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";

export type ClerkAuth = Awaited<ReturnType<typeof auth>>;

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  db: Client;
  doCatalog?: D1Database;
  auth?: ClerkAuth;
  log: SharedRequestLogger;
  projectHostnameBases: string[];
  workerScriptName?: string;
  rawRequest?: Request;
  loader?: WorkerLoader;
  codemodeSession?: DurableObjectNamespace<CodemodeSession>;
  projectDurableObjectNamespace?: DurableObjectNamespace<ProjectDurableObject>;
  stream?: DurableObjectNamespace<StreamDurableObject>;
  workerExports?: Record<string, unknown>;
  callableEnv?: Record<string, unknown>;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}
