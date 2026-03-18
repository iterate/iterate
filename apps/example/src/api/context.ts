import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { AppInitialContext, AppRequestContextBase } from "@iterate-com/shared/apps/define-app";
import type { ExampleRuntimeEnv } from "../env.ts";
import type * as schema from "./db/schema.ts";
import type { ExampleTerminalDep } from "./terminal.ts";

export type ExampleDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export interface ExampleDeps {
  env: ExampleRuntimeEnv;
  db: ExampleDb;
  terminal: ExampleTerminalDep;
}

export interface ExampleRequestContextBase extends AppRequestContextBase {
  req: AppRequestContextBase["req"] & {
    raw: Request;
  };
}

// Names the initial pre-middleware oRPC context for this app. Middleware may
// later add execution-context fields such as `requestId` and `logger`.
export type ExampleInitialOrpcContext = ExampleRequestContextBase & AppInitialContext<ExampleDeps>;
