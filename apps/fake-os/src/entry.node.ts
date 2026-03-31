import { fakeOsServiceEnvSchema } from "@iterate-com/fake-os-contract";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { openFakeOsDatabase } from "~/db/index.ts";

const env = fakeOsServiceEnvSchema.parse(process.env);

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

const db = openFakeOsDatabase(env.DATABASE_URL);

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
          log,
        };

        return handler.fetch(request, { context });
      },
    );
  },
};
