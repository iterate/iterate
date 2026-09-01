// The CONTROL-PLANE SHELL — a real second worker that a project worker falls back to (target-core §3.2/§3.4,
// the self-host / hosted topologies). It is the OUTER shell of the onion: a project's egress passes through
// here on the way out, and FIRST-PARTY / platform secrets are substituted HERE (never in the project), then it
// hits terminal. Its `invokeCapability` is the capability fallthrough (auth + first-party caps).
//
// Minimal on purpose: no DOs, no loader — just the fallback contract `{ fetch; invokeCapability }`. The real
// identity shell (OAuth AS + D1 directory) is packages/v3/control-plane; this proves the JOIN + the
// shell-onion secret layering. `firstParty` = whether PLATFORM_SECRETS_KV is bound (hosted) or not (self-host).

import { WorkerEntrypoint } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
// Type-only: the class lives in (and stays deployed with) the project-worker script — see the
// cross-script CONTEXT binding in wrangler.jsonc.
import type { IterateContextDurableObject } from "project-worker";

interface Env {
  PLATFORM_SECRETS_KV?: KVNamespace; // first-party keys (hosted only); keyed by bare name (not project-prefixed)
  // CROSS-SCRIPT binding to the project worker's IterateContextDurableObject namespace (D27): a context IS a stream,
  // so the control plane can name + write into a PROJECT's context. A project can only ever name its
  // OWN contexts (constructive isolation) — so this reach is outer→inner ONLY.
  CONTEXT?: DurableObjectNamespace<IterateContextDurableObject>;
}

export class ControlPlaneShell extends WorkerEntrypoint<Env> {
  /** Egress door: substitute PLATFORM secrets ({{secret:platform:NAME}}), then hit terminal (the internet). */
  async fetch(request: Request): Promise<Response> {
    const sub = await substituteHeaderSecrets(request, "platform", (name) =>
      this.env.PLATFORM_SECRETS_KV ? this.env.PLATFORM_SECRETS_KV.get(name) : null,
    );
    return fetch(sub); // terminal — WS-safe (only headers were rewritten)
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
      if (!env.CONTEXT) return new Response("no CONTEXT bound\n", { status: 500 });
      const name = `${projectId}.iterate${path.startsWith("/") ? path : `/${path}`}`;
      const [event] = await env.CONTEXT.getByName(name).append({
        type,
        payload: { by: "control-plane", projectId },
      });
      return Response.json({ ok: true, wroteInto: name, offset: event.offset });
    }
    return new Response("iterate control-plane (shell)\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
