/// <reference types="@cloudflare/workers-types" />

import crossws, { type CloudflareDurableAdapter } from "crossws/adapters/cloudflare";
import { getWsTest2ServiceEnv } from "@iterate-com/ws-test-2-contract";
import type { Hooks } from "crossws";
import { Env } from "../env.ts";
import { createApp } from "./api/app.ts";

const { app, ws } = await createApp<Env, CloudflareDurableAdapter>({
  env: getWsTest2ServiceEnv({}),
  ptyHooks: {
    // Keep the worker PTY behavior inline at the runtime boundary. The important
    // part is not the fallback message itself, it is that the worker entrypoint
    // never imports `./api/pty-node.ts`.
    //
    // If workerd sees that module anywhere in its reachable graph it tries to
    // bundle Node builtins from `node-pty` and crashes during local dev/startup.
    // Passing a tiny fallback hook object here keeps the shared `app.ts` logic
    // simple while making the bundle boundary explicit.
    open(peer) {
      peer.send("\r\nPTY is not implemented in Cloudflare Workers.\r\n");
      peer.close(4000, "PTY not implemented");
    },
  } satisfies Partial<Hooks>,
  createWebSocketServer: (options) => crossws(options),
});

app.get("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  if (new URL(c.req.url).pathname.startsWith("/assets/")) {
    return assetResponse;
  }

  const shellRequest = new Request(new URL("/_shell", c.req.url), c.req.raw);
  return await c.env.ASSETS.fetch(shellRequest);
});

export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // Like Node, the worker entrypoint just forwards websocket upgrades to
      // CrossWS. Route selection and protocol handling live in `app.ts`.
      return ws.handleUpgrade(request, env, context);
    }

    return app.fetch(request, env, context);
  },
};
