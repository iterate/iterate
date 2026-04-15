import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { env } from "cloudflare:workers";
import { AppConfig } from "../app.ts";

type Env = {
  APP_CONFIG?: string;
};

export default {
  fetch(_request: Request, env: Env) {
    const config = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env,
    });

    return new Response(config.message, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};
