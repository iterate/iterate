import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { AppInitialContext } from "@iterate-com/shared/jonasland";
import type { ExampleRuntimeEnv } from "../env.ts";
import type * as schema from "./db/schema.ts";

export type ExampleDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export interface ExampleDeps {
  env: ExampleRuntimeEnv;
  db: ExampleDb;
}

/**
 * Initial oRPC context for the example app.
 *
 * This deliberately models only the context that exists before middleware.
 * If middleware later adds fields such as `user` or `session`, those should be
 * inferred through middleware composition rather than added here, because
 * runtime entrypoints should only be responsible for values they truly own.
 */
export interface ExampleInitialOrpcContext extends AppInitialContext<ExampleDeps> {}
