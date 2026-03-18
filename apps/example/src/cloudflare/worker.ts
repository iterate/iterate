/// <reference types="@cloudflare/workers-types" />

import crossws from "crossws/adapters/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { RuntimeOrpcContext } from "@iterate-com/shared/jonasland";
import { ExampleAppEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import type { ExampleInitialOrpcContext } from "../api/context.ts";
import type { Env } from "./worker-env.ts";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const parsedEnv = ExampleAppEnv.parse(env);
    const db = drizzle(env.DB, { schema });
    const pathname = new URL(request.url).pathname;

    const { honoApp, crossws: workerCrossws } = await exampleApp.attachRuntime({
      honoApp: new Hono(),
      createRuntimeOrpcContext: (): RuntimeOrpcContext<ExampleInitialOrpcContext> => ({
        env: parsedEnv,
        db,
      }),
      crosswsAdapter: (options) => crossws(options),
    });

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return workerCrossws.handleUpgrade(request, env, context);
    }

    const response = await honoApp.fetch(request, env, context);
    if (response.status !== 404 || pathname.startsWith("/api/")) {
      return response;
    }

    return env.ASSETS.fetch(request);
  },
};
