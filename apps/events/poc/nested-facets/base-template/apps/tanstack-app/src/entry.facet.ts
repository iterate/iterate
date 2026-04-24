/**
 * Durable Object facet entrypoint.
 *
 * Exports `class App extends DurableObject` for the LOADER to instantiate.
 * Uses DO's built-in SQLite via drizzle-orm/durable-sqlite.
 * Runs Drizzle migrations on first request via blockConcurrencyWhile.
 */
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import handler from "@tanstack/react-start/server-entry";
import { WebSocketResponse } from "./lib/ws-response";
import { maybeUpgradeWebSocket } from "./lib/ws-upgrade";
import * as schema from "./db/schema";
import migrations from "./db/migrations";
import type { AppContext } from "./context";

export class App extends DurableObject {
  db = drizzle(this.ctx.storage, { schema });

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    migrate(this.db, migrations);
  }

  async fetch(request: Request): Promise<Response> {
    // Serve client assets from R2 via env.ASSETS (if available)
    const url = new URL(request.url);
    if (
      (this.env as any).ASSETS &&
      url.pathname.includes(".") &&
      !url.pathname.startsWith("/api/")
    ) {
      const assetResp = await (this.env as any).ASSETS.fetch(request);
      if (assetResp.status !== 404) return assetResp;
    }

    const context: AppContext = {
      db: this.db,
      pty: () => ({
        open(peer) {
          peer.send("\r\n\r\nTerminal is not available in the Cloudflare Worker runtime.\r\n");
          peer.close(4000, "Terminal not implemented");
        },
      }),
    };

    const response = await handler.fetch(request, { context });
    return maybeUpgradeWebSocket(response);
  }
}

// Default export (used when deployed as a standalone worker without DO)
export default {
  async fetch(request: Request): Promise<Response> {
    const response = await handler.fetch(request);
    return maybeUpgradeWebSocket(response);
  },
};
