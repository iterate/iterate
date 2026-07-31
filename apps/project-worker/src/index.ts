// The PROJECT WORKER — the runner (two-worker split, Phase 6). It executes projects: given a projectId it
// loads the project's confined config worker (the project config worker) into a Worker-Loader sandbox and
// serves the request. It is NOT the directory and has NO auth — the CONTROL PLANE already resolved ingress
// (host→projectId) and authenticated the caller; the project worker just runs code.
//
// Two dial transports, ONE behavior (serveConfigWorker):
//   • same account  → a service binding: `env.RUNNER.serve(request, projectId, app, caller)` (ProjectRunner).
//   • cross account → HTTP: POST /serve with a shared secret + x-iterate-* headers (the default fetch).
// Service bindings don't cross Cloudflare accounts, so the HTTP path is what makes "project worker in a
// SEPARATE account" work (topology 4).

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { CONFIG_WORKER_SOURCE } from "./config-worker.ts";

interface Env {
  LOADER: WorkerLoader;
  // Shared secret the control plane presents on the cross-account HTTP dial. Absent => HTTP dial disabled.
  RUNNER_DIAL_SECRET?: string;
}

type ProjectProps = { projectId: string };

const CALLER_HEADER = "x-iterate-caller";
const APP_HEADER = "x-iterate-app";

/** The stamped caller the control plane put on the request (unforgeable by the browser). */
interface StampedCaller {
  actor: string;
  email: string;
  member: boolean;
  role: string | null;
}

// A stable hash of the config-worker source => the loader cache key changes when the source changes.
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const CONFIG_HASH = hashSource(CONFIG_WORKER_SOURCE);

// The one place that loads + serves the confined config worker. `makeEntry` mints the per-project ITX
// loopback (the project's ONE capability surface); the config worker sees only that (the confinement).
async function serveConfigWorker(
  loader: WorkerLoader,
  request: Request,
  projectId: string,
  app: string,
  callerHeader: string,
  makeEntry: (o: { props: ProjectProps }) => Fetcher,
): Promise<Response> {
  const projectEntry = makeEntry({ props: { projectId } });
  const worker = loader.get(`project:${projectId}:${CONFIG_HASH}`, () => ({
    compatibilityDate: "2026-07-01",
    mainModule: "config.js",
    modules: { "config.js": CONFIG_WORKER_SOURCE },
    env: { ITX: projectEntry }, // the config worker sees ONLY itx — the confinement
    globalOutbound: projectEntry,
  }));
  const headers = new Headers(request.headers);
  headers.set(CALLER_HEADER, callerHeader);
  headers.set(APP_HEADER, app);
  // cp-origin rides through unchanged (set by the caller: the HTTP /serve or the service-binding dial).
  // redirect:"manual" — a redirect the config worker RETURNS (e.g. itx.auth's login 302) must pass back to
  // the browser verbatim, NOT be followed by this dispatch (which would re-enter the worker on the Location).
  return worker.getEntrypoint().fetch(new Request(request, { headers, redirect: "manual" }));
}

/** What itx.auth.gate returns: authorized (proceed), or not (with a login URL to redirect to). */
interface Gate {
  authorized: boolean;
  loginUrl?: string;
}

// itx.auth — the userspace forward-auth gate (design §11). A private app calls `env.ITX.auth.gate(...)`
// with the request's stamped caller header + cp-origin + url; it returns `{ authorized }` (proceed) or
// `{ authorized:false, loginUrl }` (redirect the browser to log in). We pass/return PRIMITIVES, not a
// Request/Response: over Workers RPC, `fetch` is a reserved method name and Request/Response are not
// reliably serializable across the loopback — so the ergonomic "partial fetch" is expressed as a small
// value-returning call the config worker turns into a Response. The membership decision reads the STAMPED
// caller (`x-iterate-caller`, member/role) the control plane overwrites on ingress — a browser can't forge
// it. The config worker passing its own request's headers is fine: it's the owner's code gating its own app.
export class ProjectAuth extends RpcTarget {
  gate(callerHeader: string | null, cpOrigin: string | null, requestUrl: string): Gate {
    const caller = callerHeader ? (JSON.parse(callerHeader) as StampedCaller) : null;
    if (caller?.member === true) return { authorized: true };
    if (cpOrigin) {
      const login = new URL("/login", cpOrigin);
      login.searchParams.set("next", requestUrl);
      return { authorized: false, loginUrl: login.toString() };
    }
    return { authorized: false };
  }
}

// The per-project ITX capability surface (env.ITX + globalOutbound inside the sandbox). whoami + auth;
// the kernel's fuller ProjectCapabilities (streams/secrets/ai + egress) folds in behind the same shape.
export class ProjectEntrypoint extends WorkerEntrypoint<Env, ProjectProps> {
  whoami(): ProjectProps {
    return this.ctx.props;
  }
  get auth(): ProjectAuth {
    return new ProjectAuth();
  }
  async fetch(request: Request): Promise<Response> {
    return fetch(request); // globalOutbound must be a real Fetcher.fetch; pass-through for now.
  }
}

// The exports shape for the ctx.exports loopback (minting the per-request ProjectEntrypoint).
type RunnerExports = { exports: { ProjectEntrypoint(o: { props: ProjectProps }): Fetcher } };

// Same-account dial target: a service binding the control plane calls as `env.RUNNER.serve(...)`.
export class ProjectRunner extends WorkerEntrypoint<Env> {
  serve(request: Request, projectId: string, app: string, callerHeader: string): Promise<Response> {
    const makeEntry = (this.ctx as unknown as RunnerExports).exports.ProjectEntrypoint;
    return serveConfigWorker(this.env.LOADER, request, projectId, app, callerHeader, makeEntry);
  }
}

export default {
  // Cross-account dial: POST /serve with the shared secret + x-iterate-project-id / -app / -caller headers.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/serve")
      return new Response("project worker: POST /serve\n", { status: 404 });

    const secret = env.RUNNER_DIAL_SECRET;
    const presented = request.headers.get("x-iterate-dial-secret");
    if (!secret || presented !== secret) return new Response("forbidden\n", { status: 403 });

    const projectId = request.headers.get("x-iterate-project-id");
    if (!projectId) return new Response("missing x-iterate-project-id\n", { status: 400 });
    const app = request.headers.get("x-iterate-app") ?? "";
    const callerHeader = request.headers.get(CALLER_HEADER) ?? "null";

    const makeEntry = (ctx as unknown as RunnerExports).exports.ProjectEntrypoint;
    // Serve against a clean "/" request so the config worker's own routing (e.g. /__debug) is addressable
    // via a forwarded path header, not the /serve envelope.
    const inner = new Request(url.origin + (request.headers.get("x-iterate-path") ?? "/"), {
      method: "GET",
      headers: request.headers,
    });
    return serveConfigWorker(env.LOADER, inner, projectId, app, callerHeader, makeEntry);
  },
};
