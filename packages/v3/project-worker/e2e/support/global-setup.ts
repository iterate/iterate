// e2e/support/global-setup.ts — boots the REAL project-worker ONCE for the whole vitest E2E run
// (the apps/os shape: one worker, addressed by URL, shared by every file — no per-file boot). It
// builds through the production build hook, runs in local workerd with local KV / Durable Objects /
// the Worker Loader, and tests speak to it EXACTLY like production clients — capnweb over WebSocket
// at /api. One patch: FALLBACK rebinds to this worker's own DummyControlPlane entrypoint (the SOLO
// topology from wrangler.jsonc's own comment), so no external control-plane worker is needed.
//
// The URL is handed to tests via vitest `provide`/`inject` (see support/setup.ts + support/client.ts).

import { createServer, type Server } from "node:http";
import { nodeHttpBatchRpcResponse, RpcTarget } from "capnweb";
import { createTestHarness } from "wrangler";
import type { TestProject } from "vitest/node";
import { PACKAGE_DIR, soloWorkerConfig } from "./solo-config.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** Base URL of the one E2E worker, e.g. http://127.0.0.1:1234 — every test opens capnweb here. */
    workerBaseUrl: string;
    /** URL of the dummy REMOTE capnweb API (Node-hosted) that workers-remote-capnweb.e2e dials. */
    dummyCapnwebUrl: string;
  }
}

// ── the dummy REMOTE capnweb API — a tiny Node server the same globalSetup owns.
// workers-remote-capnweb.e2e's USERSPACE worker dials it over one HTTP batch through the context's egress. `.math` is a NESTED RpcTarget passed by reference, so a
// genuine MULTI-HOP chain exists (`api.math.add(2,3)`: a property hop THEN a call). ──
class MathApi extends RpcTarget {
  add(a: number, b: number): number {
    return a + b;
  }
}
class DummyApi extends RpcTarget {
  hello(name: string): string {
    return `hi ${name} from dummy-capnweb`;
  }
  add(a: number, b: number): number {
    return a + b;
  }
  get math(): MathApi {
    return new MathApi();
  }
  /** A capability returned from a CALL (not a property) — `svc('math').add(…)` is the call-then-call
   *  chain shape the `itx.os.projects.get(id).rename(…)` header advertises. */
  svc(_name: string): MathApi {
    return new MathApi();
  }
}

function startDummyCapnweb(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void nodeHttpBatchRpcResponse(req, res, new DummyApi()).catch(() => res.end());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/api`, server });
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // DEPLOYED-TARGET MODE — the proof that counts: `WORKER_BASE_URL=https://project-worker.<sub>.workers.dev
  // pnpm e2e` runs the SAME suite against the deployed worker, no local boot. The dummy remote API is
  // Node-hosted here, unreachable from the edge, so workers-remote-capnweb.e2e skips unless
  // `DUMMY_CAPNWEB_URL` names a public one (a captun tunnel).
  const deployedWorkerBaseUrl = process.env.WORKER_BASE_URL;
  if (deployedWorkerBaseUrl) {
    project.provide("workerBaseUrl", deployedWorkerBaseUrl);
    project.provide("dummyCapnwebUrl", process.env.DUMMY_CAPNWEB_URL ?? "");
    return async () => {};
  }
  const config = soloWorkerConfig();
  const server = createTestHarness({ root: PACKAGE_DIR, workers: [{ config }] });
  const { url } = await server.listen();
  const dummy = await startDummyCapnweb();
  project.provide("workerBaseUrl", url.href);
  project.provide("dummyCapnwebUrl", dummy.url);
  return async () => {
    dummy.server.close();
    await server.close();
  };
}
