import { resolve } from "node:path";
import { drizzle as drizzleNode } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";

const env = z
  .object({
    DB_PATH: z.string().trim().min(1).default("os.db"),
  })
  .parse(process.env);

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

const db = drizzleNode(env.DB_PATH, { schema });
db.$client.pragma("journal_mode = WAL");
migrate(db, { migrationsFolder: resolve("drizzle") });

/**
 * Build the request-scoped app context that TanStack Start handlers and oRPC
 * procedures expect in the Node runtime.
 *
 * First-party refs:
 * - TanStack Start server entrypoint: https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point
 * - oRPC TanStack Start SSR: https://orpc.dev/docs/adapters/tanstack-start
 */
export function createNodeAppContext(args: {
  request: Request;
  log: SharedRequestLogger;
}): AppContext {
  return {
    manifest,
    config,
    rawRequest: args.request,
    db,
    log: args.log,
  };
}

export { config, manifest };
