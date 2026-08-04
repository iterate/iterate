// The CONTROL-PLANE SHELL — a real second worker that a project worker falls back to (target-core §3.2/§3.4,
// the self-host / hosted topologies). It is the OUTER shell of the onion: a project's egress passes through
// here on the way out, and FIRST-PARTY / platform secrets are substituted HERE (never in the project), then it
// hits terminal. Its `invokeCapability` is the capability fallthrough (auth + first-party caps).
//
// Minimal on purpose: no DOs, no loader — just the fallback contract `{ fetch; invokeCapability }`. The real
// identity shell (OAuth AS + D1 directory) is the existing apps/control-plane; this proves the JOIN + the
// shell-onion secret layering. `firstParty` = whether PLATFORM_SECRETS_KV is bound (hosted) or not (self-host).

import { WorkerEntrypoint } from "cloudflare:workers";
import { substituteHeaderSecrets } from "./core/egress.ts";

interface Env {
  PLATFORM_SECRETS_KV?: KVNamespace; // first-party keys (hosted only); keyed by bare name (not project-prefixed)
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
  fetch(): Response {
    return new Response("iterate control-plane (shell)\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
