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
import {
  APP_HEADER,
  CALLER_HEADER,
  DIAL_SECRET_HEADER,
  PATH_HEADER,
  PROJECT_ID_HEADER,
  type StampedCaller,
} from "@v3/shared/dial";
import { CONFIG_WORKER_SOURCE } from "./config-worker.ts";

interface Env {
  LOADER: WorkerLoader;
  // Shared secret the control plane presents on the cross-account HTTP dial. Absent => HTTP dial disabled.
  RUNNER_DIAL_SECRET?: string;
}

type ProjectProps = { projectId: string };

// Envelope + credential headers stripped before the confined config worker sees the request. The dial
// secret especially: leaking it to untrusted project code would let it impersonate the control plane.
const STRIP_INTO_SANDBOX = [
  DIAL_SECRET_HEADER,
  PROJECT_ID_HEADER,
  PATH_HEADER,
  "cookie",
  "authorization",
];

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
  for (const h of STRIP_INTO_SANDBOX) headers.delete(h); // envelope + credentials never enter the sandbox
  headers.set(CALLER_HEADER, callerHeader); // trusted, set by us
  headers.set(APP_HEADER, app);
  // cp-origin rides through unchanged (set by the trusted caller: HTTP /serve or the service-binding dial).
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
// reliably serializable across the loopback — so the ergonomic "partial fetch" is a small value-returning
// call the config worker turns into a Response.
//
// TRUST MODEL (reviewed): gate authorizes on `caller.member`, read from the `x-iterate-caller` the config
// worker passes. Two facts make that safe TODAY: (a) the control plane builds a FRESH header set on the
// dial (ingress.ts) and never forwards the browser's inbound x-iterate-* — so a browser cannot forge
// membership; (b) the config worker here is our FIXED template, which faithfully forwards the header we
// stamped. LATENT RISK: when arbitrary *userspace* code is loaded as the config worker, it could pass a
// forged `{member:true}` and self-authorize. Before that lands, private-app enforcement must move to the
// runner (which holds the trusted per-request caller) instead of this sandbox-initiated call. Tracked in
// the review-response doc.
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
    // globalOutbound: a real Fetcher.fetch. TODO(egress): today this is an UNRESTRICTED pass-through to the
    // internet — the kernel's two-level egress door (secret substitution, origin-pinning) must land here
    // before untrusted multi-tenant use; until then the "confinement" is capability-scoping, not egress.
    return fetch(request);
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

/** Constant-time string compare — avoids leaking the secret via response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  // Cross-account dial: POST /serve with the shared secret + x-iterate-project-id / -app / -caller headers.
  // NB: ingress is GET-only for now (the dial conveys no method/body) — same for both transports.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/serve")
      return new Response("project worker: POST /serve\n", { status: 404 });

    const secret = env.RUNNER_DIAL_SECRET;
    const presented = request.headers.get(DIAL_SECRET_HEADER);
    if (!secret || !presented || !timingSafeEqual(presented, secret)) {
      return new Response("forbidden\n", { status: 403 });
    }

    const projectId = request.headers.get(PROJECT_ID_HEADER);
    if (!projectId) return new Response(`missing ${PROJECT_ID_HEADER}\n`, { status: 400 });
    const app = request.headers.get(APP_HEADER) ?? "";
    const callerHeader = request.headers.get(CALLER_HEADER) ?? "null";

    const makeEntry = (ctx as unknown as RunnerExports).exports.ProjectEntrypoint;
    // Serve against a clean request at the forwarded path (the config worker's own routing, e.g. /__debug),
    // NOT the /serve envelope. serveConfigWorker strips the envelope + credentials before the sandbox.
    const inner = new Request(url.origin + (request.headers.get(PATH_HEADER) ?? "/"), {
      method: "GET",
      headers: request.headers,
    });
    return serveConfigWorker(env.LOADER, inner, projectId, app, callerHeader, makeEntry);
  },
};
