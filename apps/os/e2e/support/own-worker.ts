// e2e/support/own-worker.ts — a worker a test file boots for ITSELF, beside the shared one every other
// file speaks to through support/client.ts. Two reasons to own one: reading the worker's console
// (wrangler's `getLogs()` is worker-global, so nobody else may drive it — push-delivery-no-dropped-warns
// and apps/agents agents-partner-response-stream), or a non-default ingress routing (path-ingress).
// Same config (support/worker-config.ts), same capnweb-over-WebSocket door.

import { newWebSocketRpcSession } from "capnweb";
import type { IngressRouting } from "iterate/project-ingress";
import { createTestHarness } from "wrangler";
import { E2E_ADMIN_API_SECRET, e2eWorkerConfig, PACKAGE_DIR } from "./worker-config.ts";

export type OwnWorker = {
  /** Base URL of this worker, e.g. http://127.0.0.1:1234. */
  url: URL;
  /** A fresh session's authenticated itx for `ctx` — its root context. */
  itx(ctx: string): any;
  /** A fresh session creates project `slug` and hands back its root itx. */
  createProject(slug: string): Promise<any>;
  /** Everything the worker logged so far, as one string to grep. */
  logs(): string;
  /** Dispose every session this worker minted, then stop workerd. */
  stop(): Promise<void>;
};

export async function startOwnWorker(
  opts: { ingressRouting?: NonNullable<IngressRouting> } = {},
): Promise<OwnWorker> {
  const server = createTestHarness({
    root: PACKAGE_DIR,
    workers: [{ config: e2eWorkerConfig(undefined, opts.ingressRouting) }],
  });
  const { url } = await server.listen();
  await server.update({
    root: PACKAGE_DIR,
    workers: [{ config: e2eWorkerConfig(url.origin, opts.ingressRouting) }],
  });
  const sessions: unknown[] = [];
  const admin = () => {
    const s = newWebSocketRpcSession(`ws://${url.host}/api`);
    sessions.push(s);
    return (s as any).authenticate({ type: "admin-secret", secret: E2E_ADMIN_API_SECRET });
  };
  return {
    url,
    itx: (ctx) => admin().projects.get(ctx),
    createProject: (slug) => admin().projects.create({ project: slug }),
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
