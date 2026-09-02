// e2e/support/log-harness.ts — a SECOND worker, booted by the ONE file whose assertions read the
// worker's console (wrangler's `getLogs()`): the delivery loop's "no dropped-push warn / no dispatch
// error" pins (push-delivery-no-dropped-warns.e2e). Logs are worker-global, so those tests need a
// worker nobody else drives — everything else in the lane speaks to the shared worker through
// support/client.ts. Same SOLO topology (support/solo-config.ts), same capnweb-over-WebSocket door.

import { newWebSocketRpcSession } from "capnweb";
import { createTestHarness } from "wrangler";
import { PACKAGE_DIR, soloWorkerConfig } from "./solo-config.ts";

export type LoggedWorker = {
  /** Base URL of this worker, e.g. http://127.0.0.1:1234. */
  url: URL;
  /** A fresh session's authenticated itx for `ctx` — its root context. */
  itx(ctx: string): any;
  /** A raw capnweb session (an `UnauthenticatedSession` stub). */
  session(): any;
  /** Everything the worker logged so far, as one string to grep. */
  logs(): string;
  /** Dispose every session this worker minted, then stop workerd. */
  stop(): Promise<void>;
};

export async function startLoggedWorker(): Promise<LoggedWorker> {
  const server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [{ config: soloWorkerConfig() }],
  });
  const { url } = await server.listen();
  const sessions: unknown[] = [];
  const openSession = () => {
    const s = newWebSocketRpcSession(`ws://${url.host}/api`);
    sessions.push(s);
    return s as any;
  };
  return {
    url,
    session: openSession,
    itx: (ctx) => openSession().authenticate().projects.get(ctx),
    logs: () => JSON.stringify(server.getLogs()),
    stop: async () => {
      for (const s of sessions) {
        try {
          (s as Partial<Disposable>)[Symbol.dispose]?.();
        } catch {
          /* already broken */
        }
      }
      await server.close();
    },
  };
}
