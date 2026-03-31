import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import manifest, { type AppConfig } from "~/app.ts";
import type * as schema from "~/db/schema.ts";

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  db: BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;
  loader: WorkerLoader;
  outbound: Fetcher;
  log: SharedRequestLogger;
  rawRequest?: Request;
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
