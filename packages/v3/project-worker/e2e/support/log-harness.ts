// e2e/support/log-harness.ts — a SECOND worker, booted by the ONE file whose assertions read the
// worker's console (wrangler's `getLogs()`): the delivery loop's "no dropped-push warn / no dispatch
// error" pins (push-delivery-no-dropped-warns.e2e). Logs are worker-global, so those tests need a
// worker nobody else drives — everything else in the lane speaks to the shared worker through
// support/client.ts. Same config (support/worker-config.ts), same capnweb-over-WebSocket door.

import { newWebSocketRpcSession } from "capnweb";
import { createTestHarness } from "wrangler";
import { E2E_ADMIN_API_SECRET, e2eWorkerConfig, PACKAGE_DIR } from "./worker-config.ts";

export type LoggedWorker = {
  /** Base URL of this worker, e.g. http://127.0.0.1:1234. */
  url: URL;
  /** A fresh session's authenticated itx for `ctx` — its root context. */
  itx(ctx: string): any;
  /** Everything the worker logged so far, as one string to grep. */
  logs(): string;
  /** Dispose every session this worker minted, then stop workerd. */
  stop(): Promise<void>;
};

export async function startLoggedWorker(): Promise<LoggedWorker> {
  const server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [{ config: e2eWorkerConfig() }],
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
    itx: (ctx) =>
      openSession()
        .authenticate({ type: "admin-secret", secret: E2E_ADMIN_API_SECRET })
        .projects.get(ctx),
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
