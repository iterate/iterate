import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { AppInitialContext } from "@iterate-com/shared/apps/define-app";
import type { ExampleRuntimeEnv } from "../env.ts";
import type * as schema from "./db/schema.ts";
import type { ExampleTerminalDep } from "./terminal.ts";

export type ExampleDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export interface ExampleDeps {
  env: ExampleRuntimeEnv;
  db: ExampleDb;
  terminal: ExampleTerminalDep;
}

export type ExampleInitialOrpcContext = AppInitialContext<ExampleDeps>;
