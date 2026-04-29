import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./db/schema";
import type { WebSocketHooks } from "./lib/ws-response";

export interface AppContext {
  db: BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;
  pty: () => Partial<WebSocketHooks>;
}

// Register context with TanStack Start so Route.server.handlers receive it
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
