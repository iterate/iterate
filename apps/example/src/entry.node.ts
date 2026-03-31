import { resolve } from "node:path";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { z } from "zod";
import { drizzle as drizzleNode } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";
import { spawnNodePtyProcess } from "~/lib/node-pty.ts";
import { createTerminalWebSocketHooks } from "~/lib/terminal-websocket.ts";

const env = z
  .object({
    DB_PATH: z.string().trim().min(1).default("example.db"),
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

export default {
  async fetch(request: Request) {
    return withEvlog(
      {
        request,
        manifest,
        config,
      },
      async ({ log }) => {
        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          pty: (request) =>
            createTerminalWebSocketHooks({
              request,
              spawn: spawnNodePtyProcess,
            }),
          log,
        };

        return handler.fetch(request, {
          context,
        });
      },
    );
  },
};
