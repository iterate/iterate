// __tests__/harness.ts — boots the REAL project-worker under wrangler's createTestHarness (the
// cloudflare-os integration-tests pattern, adapted): the worker builds through its production
// build hook (build-sdk), runs in local workerd with local KV /
// Durable Objects / the Worker Loader, and tests speak to it exactly like production clients —
// capnweb over WebSocket at /api. One patch: FALLBACK rebinds to this worker's own
// DummyControlPlane entrypoint (the SOLO topology from wrangler.jsonc's own comment), so the
// harness needs no external control-plane worker.

import { newWebSocketRpcSession } from "capnweb";
import { createTestHarness, type TestHarness } from "wrangler";
import { PACKAGE_DIR, soloWorkerConfig } from "../e2e/support/solo-config.ts";

export type ProjectHarness = {
  server: TestHarness;
  /** Base URL of the running worker, e.g. http://127.0.0.1:1234. */
  url: URL;
  /** A fresh session's authenticated itx for a project ctx — its root context (capnweb over
   *  WebSocket, the real client): `session().authenticate().projects.get(ctx)`. */
  itx(ctx: string): any;
  /** A raw capnweb session (an `UnauthenticatedSession` stub) for flows that need the session
   *  itself — its identity, its disposal. */
  session(): any;
  /** Worker console output captured by the harness (wrangler getLogs) — assert on log lines. */
  logs(): unknown;
  /** Dispose every capnweb session this harness minted, then stop workerd (the cloudflare-os
   *  lesson: sessions left open at teardown turn into unhandled-rejection noise). */
  stop(): Promise<void>;
};

export async function startProjectHarness(): Promise<ProjectHarness> {
  const config = soloWorkerConfig();
  const server = createTestHarness({ root: PACKAGE_DIR, workers: [{ config }] });
  const { url } = await server.listen();
  const wsBase = `ws://${url.host}`;
  const sessions: unknown[] = [];
  const openSession = () => {
    const s = newWebSocketRpcSession(`${wsBase}/api`);
    sessions.push(s);
    return s as any;
  };
  return {
    server,
    url,
    session: openSession,
    itx: (ctx: string) => openSession().authenticate().projects.get(ctx),
    logs: () => server.getLogs(),
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
