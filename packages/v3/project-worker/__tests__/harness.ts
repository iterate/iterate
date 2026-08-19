// __tests__/harness.ts — boots the REAL project-worker under wrangler's createTestHarness (the
// cloudflare-os integration-tests pattern, adapted): the worker builds through its production
// build hook (build-sdk + capnweb-validate mirror), runs in local workerd with local KV /
// Durable Objects / the Worker Loader, and tests speak to it exactly like production clients —
// capnweb over WebSocket at /api. One patch: FALLBACK rebinds to this worker's own
// DummyControlPlane entrypoint (the SOLO topology from wrangler.jsonc's own comment), so the
// harness needs no external control-plane worker.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";
import { newWebSocketRpcSession } from "capnweb";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** jsonc → object without a parser dependency: strip comments + trailing commas (our config
 *  keeps strings comment-free, so the naive strip is safe HERE — not a general jsonc parser). */
function readWranglerConfig(): Record<string, unknown> {
  const raw = readFileSync(join(PACKAGE_DIR, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

export type ProjectHarness = {
  server: TestHarness;
  /** Base URL of the running worker, e.g. http://127.0.0.1:1234. */
  url: URL;
  /** A fresh authenticated itx for a project ctx (capnweb over WebSocket — the real client). */
  itx(ctx: string): any;
  /** The raw capnweb session for a ctx (for connect() flows that need session identity). */
  session(ctx: string): any;
  /** Worker console output captured by the harness (wrangler getLogs) — assert on log lines. */
  logs(): unknown;
  /** Dispose every capnweb session this harness minted, then stop workerd (the cloudflare-os
   *  lesson: sessions left open at teardown turn into unhandled-rejection noise). */
  stop(): Promise<void>;
};

export async function startProjectHarness(): Promise<ProjectHarness> {
  const config = readWranglerConfig();
  config.main = join(PACKAGE_DIR, String(config.main));
  config.build = { ...(config.build as object), cwd: PACKAGE_DIR };
  // Fresh local storage can't replay prod's rename-chain history — only the LIVE class matters.
  config.migrations = [{ tag: "local", new_sqlite_classes: ["StreamDurableObject"] }];
  // SOLO topology: egress + itx.os bottom out at this worker's own dummy control plane.
  config.services = [
    { binding: "FALLBACK", service: String(config.name), entrypoint: "DummyControlPlane" },
  ];
  const server = createTestHarness({ root: PACKAGE_DIR, workers: [{ config: config as never }] });
  const { url } = await server.listen();
  const wsBase = `ws://${url.host}`;
  const sessions: unknown[] = [];
  const openSession = (ctx: string) => {
    const s = newWebSocketRpcSession(`${wsBase}/api?ctx=${ctx}`);
    sessions.push(s);
    return s as any;
  };
  const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
  return {
    server,
    url,
    session: openSession,
    itx: (ctx: string) => openSession(ctx).authenticate().get(),
    logs: () => server.getLogs(),
    stop: async () => {
      for (const s of sessions) {
        try {
          if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
        } catch {
          /* already broken */
        }
      }
      await server.close();
    },
  };
}
