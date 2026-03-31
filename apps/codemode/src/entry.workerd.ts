import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { drizzle as drizzleWorkerd } from "drizzle-orm/d1";
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
          db,
          loader: env.LOADER,
          outbound: env.OUTBOUND,
          log,
          rawRequest: request,
        };

        return handler.fetch(request, {
          context,
        });
      },
    );
  },
};
