import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { drizzle as drizzleWorkerd } from "drizzle-orm/d1";
import crossws from "crossws/adapters/cloudflare";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});
const db = drizzleWorkerd(workerEnv.DB, { schema });

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          pty: () => ({
            message: (peer) => {
              peer.send(`\r\n\r\nTerminal is not available in the Cloudflare Worker runtime.\r\n`);
              peer.close(4000, "Terminal not implemented");
            },
          }),
          log,
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};
