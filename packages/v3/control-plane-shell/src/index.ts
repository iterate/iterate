// The CONTROL-PLANE SHELL — a real second worker that a project worker falls back to (target-core §3.2/§3.4,
// the self-host / hosted topologies). It is the OUTER shell of the onion: a project's egress passes through
// here on the way out, and FIRST-PARTY / platform secrets are substituted HERE (never in the project), then it
// hits terminal. Its `invokeCapability` is the capability fallthrough (auth + first-party caps).
//
// Minimal on purpose: no DOs, no loader — just the fallback contract `{ fetch; invokeCapability }`. The real
// identity shell (OAuth AS + D1 directory) is packages/v3/control-plane; this proves the JOIN + the
// shell-onion secret layering. `firstParty` = whether PLATFORM_SECRETS_KV is bound (hosted) or not (self-host).

import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import { createProject, listProjects, projectExists } from "../sql/.generated/index.ts";
// Type-only: the class lives in (and stays deployed with) the project-worker script — see the
// cross-script ITERATE_CONTEXT binding in wrangler.jsonc.
import type { IterateContextDurableObject } from "project-worker";

interface Env {
  PLATFORM_SECRETS_KV?: KVNamespace; // first-party keys (hosted only); keyed by bare name (not project-prefixed)
  /** THE DIRECTORY, minimal (definitions.sql): which projects exist — and nothing else, on purpose. */
  DB: D1Database;
  /** The bearer the admin door (`POST /projects`) wants — a wrangler secret; unset ⇒ the door is closed. */
  CONTROL_PLANE_ADMIN_TOKEN?: string;
  // CROSS-SCRIPT binding to the project worker's IterateContextDurableObject namespace (D27): a context IS a stream,
  // so the control plane can name + write into a PROJECT's context. A project can only ever name its
  // OWN contexts (constructive isolation) — so this reach is outer→inner ONLY.
  ITERATE_CONTEXT?: DurableObjectNamespace<IterateContextDurableObject>;
}

export class ControlPlaneShell extends WorkerEntrypoint<Env> {
  /** Egress door: substitute PLATFORM secrets ({{secret:platform:NAME}}), then hit terminal (the internet). */
  async fetch(request: Request): Promise<Response> {
    const sub = await substituteHeaderSecrets(request, "platform", (name) =>
      this.env.PLATFORM_SECRETS_KV ? this.env.PLATFORM_SECRETS_KV.get(name) : null,
    );
    return fetch(sub); // terminal — WS-safe (only headers were rewritten)
  }

  /** Does this project exist? The one question a project worker asks before it dials a context for a
   *  project host (`<label>--<projectId>.<base>`): an unknown project is 421 at the edge, so a stranger's
   *  hostname never creates a Durable Object (wave 0, issue 1). Strongly consistent — D1, no KV lag. */
  async projectExists(projectId: string): Promise<boolean> {
    return (await projectExists(createD1Client(this.env.DB), { id: projectId })) !== null;
  }

  /** Register a project (idempotent). Over Workers RPC for first-party callers; over HTTP at
   *  `POST /projects` with the admin bearer for a CLI or a test. */
  async createProject(projectId: string): Promise<{ id: string; created: boolean }> {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId))
      throw new Error(`createProject: ${JSON.stringify(projectId)} is not a project id ([A-Za-z0-9_-]+)`);
    const row = await createProject(createD1Client(this.env.DB), { id: projectId });
    return { id: projectId, created: row !== null };
  }

  /** Capability fallthrough for a project (target-core §3.4). Minimal: auth is a local-admin stand-in. */
  async invokeCapability(callPath: string, _args?: unknown[]): Promise<unknown> {
    if (callPath === "itx.auth.gate") return { ok: true };
    throw new Error(`control-plane: no capability "${callPath}"`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The OUTER shell writing INTO a project's context (D27): the control plane names
    // `{projectId}.iterate{path}` (the SAME codec a project's itx.streams builds) and appends —
    // e.g. a project-created event or a routed inbound webhook. A project can only ever name its
    // own contexts, so this direction is outer→inner.
    if (url.pathname === "/emit") {
      const projectId = url.searchParams.get("projectId") ?? "";
      const path = url.searchParams.get("path") ?? "/inbox";
      const type = url.searchParams.get("type") ?? "project-created";
      if (!env.ITERATE_CONTEXT) return new Response("no CONTEXT bound\n", { status: 500 });
      const name = `${projectId}.iterate${path.startsWith("/") ? path : `/${path}`}`;
      // workers-types' Rpc.Serializable rejects `unknown`, so a stub method returning StreamEvent
      // (payload: Record<string, unknown>) types as `never` — the value is a plain committed event.
      const [event] = (await env.ITERATE_CONTEXT.getByName(name).append({
        type,
        payload: { by: "control-plane", projectId },
      })) as unknown as { offset: number }[];
      return Response.json({ ok: true, wroteInto: name, offset: event.offset });
    }
    // THE ADMIN DOOR for the directory: `POST /projects { id }` registers (idempotent), `GET /projects/<id>`
    // answers 200 or 404, `GET /projects` lists the newest. Bearer = CONTROL_PLANE_ADMIN_TOKEN; without the
    // secret bound the door is closed. A CLI or an e2e run registers its projects here.
    if (url.pathname === "/projects" || url.pathname.startsWith("/projects/")) {
      const token = env.CONTROL_PLANE_ADMIN_TOKEN;
      const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!token || presented !== token) return new Response("admin bearer required\n", { status: 401 });
      const shell = new ControlPlaneShell({} as ExecutionContext, env);
      const client = createD1Client(env.DB);
      if (request.method === "POST" && url.pathname === "/projects") {
        const body = (await request.json().catch(() => null)) as { id?: string } | null;
        if (!body?.id) return new Response("POST /projects wants { id }\n", { status: 400 });
        return Response.json(await shell.createProject(body.id));
      }
      if (request.method === "GET" && url.pathname === "/projects")
        return Response.json(await listProjects(client, { limit: 100 }));
      if (request.method === "GET") {
        const id = decodeURIComponent(url.pathname.slice("/projects/".length));
        return (await shell.projectExists(id))
          ? Response.json({ id })
          : new Response("no such project\n", { status: 404 });
      }
      return new Response("method\n", { status: 405 });
    }
    return new Response("iterate control-plane (shell)\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
