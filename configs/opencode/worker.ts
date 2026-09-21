// The project worker of the opencode template. It does three small things:
//
//   1. names the opencode Durable Object (a stateful dynamic worker ref — the
//      platform builds `apps/opencode/opencode.ts` from this repo with the
//      `workerd` bundle condition opencode's workerd profile requires);
//   2. exposes it on the capability tree as `itx.worker.opencode` (the getter
//      below — `itx.worker.opencode.prompt({ text })` is one flattened RPC);
//   3. forwards the `opencode` app host to the object's own `fetch`, behind
//      project-member auth.
//
// Everything else — sessions, the model call, the credential — lives in the
// object (apps/opencode/opencode.ts).

import {
  IterateWorkerEntrypoint,
  type StatefulDynamicWorkerRef,
  type StreamEvent,
} from "iterate/sdk";
import type { OpencodeAgent } from "./apps/opencode/opencode.ts";

/** The object's RPC surface as seen through `itx.workers.get` (platform verbs excluded). */
type OpencodeRpc = Pick<OpencodeAgent, "prompt" | "sessions" | "messages" | "health">;

export const OPENCODE_WORKER: StatefulDynamicWorkerRef = {
  type: "stateful",
  path: "/",
  className: "OpencodeAgent",
  durableWorkerKey: "opencode",
  source: {
    createWorker: {
      entryPoint: "apps/opencode/opencode.ts",
      conditions: ["workerd"],
      minify: true,
      files: { type: "repo", repoPath: "/repos/config" },
    },
  },
};

export default class ProjectWorker extends IterateWorkerEntrypoint {
  /** `itx.worker.opencode.<method>(...)` — the object's RPC surface (prompt, sessions, messages, health). */
  get opencode() {
    return this.itx.workers.get<OpencodeRpc>(OPENCODE_WORKER);
  }

  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (event.type === "events.iterate.com/project/worker-updated" && event.path === "/") {
      // Warm the object once the config worker is live, so the first visit
      // does not pay for the (large) opencode build.
      await this.opencode.health();
    }
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "opencode") {
      const authResponse = await this.fetchProjectAuth(req, { policy: "project-member" });
      if (authResponse) return authResponse;
      return await this.fetchDynamicWorker(req, OPENCODE_WORKER, { buildBudgetMs: 60_000 });
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });

    const url = new URL(req.url);
    const opencodeUrl =
      req.headers.get("x-iterate-host-kind") === "custom"
        ? `${url.protocol}//opencode.${url.host}/`
        : `${url.protocol}//opencode--${url.host}/`;
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from the opencode project worker.</p>
              <ul>
                <li><a href="${opencodeUrl}">opencode</a> (opencode v2 in a Durable Object, project members only)</li>
              </ul>
              <p>From any itx runtime: <code>await itx.worker.opencode.prompt({ text: "hi" })</code></p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
