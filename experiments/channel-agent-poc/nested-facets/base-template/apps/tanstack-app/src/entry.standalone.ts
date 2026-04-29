/**
 * Standalone Cloudflare Worker entrypoint.
 *
 * Deploys as a regular CF Worker with D1 for the database.
 * Uses drizzle-orm/d1 adapter. Migrations are handled by wrangler
 * (`wrangler d1 migrations apply`), not at runtime.
 */
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import handler from "@tanstack/react-start/server-entry";
import { maybeUpgradeWebSocket } from "./lib/ws-upgrade";
import * as schema from "./db/schema";
import type { AppContext } from "./context";

interface WorkerEnv {
  DB: D1Database;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const db = drizzle((env as unknown as WorkerEnv).DB, { schema });

    const context: AppContext = {
      db,
      pty: () => ({
        open(peer) {
          peer.send("\r\n\r\nTerminal is not available in the Cloudflare Worker runtime.\r\n");
          peer.close(4000, "Terminal not implemented");
        },
      }),
    };

    const response = await handler.fetch(request, { context });
    return maybeUpgradeWebSocket(response);
  },
};
