// The PROJECT WORKER — walking skeleton (target-core §6.0). Proves a "proper" fetch — WebSocket upgrades and
// all — through the WHOLE stack, in SOLO mode (no control plane; the fallback is this worker's own
// DummyControlPlane loopback entrypoint).
//
// Two routes:
//   • GET /ws            — INGRESS WS: edge fetch → ITX_HOST DO-stub fetch → ctx.acceptWebSocket() → echo.
//   • GET /egress-test   — EGRESS WS: load a confined agent whose outbound WS (via globalOutbound → the
//                          egress door → the fallback → terminal) loops back over the internet to our own /ws.
//                          One request exercises ALL FOUR §6.0 risk points at once.

import { WorkerEntrypoint } from "cloudflare:workers";
import { ItxDurableObject } from "./itx-durable-object.ts";
import { substituteHeaderSecrets } from "./core/egress.ts";
import { parseAppConfig, type AppConfig } from "./core/config.ts";

export { ItxDurableObject };
// Preserve the pre-skeleton runner exports so a live control-plane RUNNER binding keeps resolving.
export { ProjectRunner, ProjectEntrypoint, ProjectAuth } from "./index.ts";

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  APP_CONFIG?: string;
}

// A confined dynamic worker whose ONLY outbound path is globalOutbound (the egress door). It opens an
// outbound WS to `target`, sends a ping, awaits the echo, reports whether the full round trip worked.
const EGRESS_WS_AGENT = /* js */ `
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("target");
    const sent = "ping-through-egress";
    let resp;
    try {
      // Outbound WS via a fetch Upgrade — intercepted by globalOutbound (the egress chain). The
      // Authorization header carries a secret PLACEHOLDER the egress door substitutes on the way out.
      resp = await fetch(target, { headers: { Upgrade: "websocket", Authorization: "Bearer {{secret:project:demo}}" } });
    } catch (e) {
      return Response.json({ ok: false, stage: "fetch", error: String(e && e.message || e) });
    }
    if (resp.status !== 101 || !resp.webSocket) {
      return Response.json({ ok: false, stage: "upgrade", status: resp.status, reason: "no webSocket on response" });
    }
    const ws = resp.webSocket;
    ws.accept();
    // Echo servers may send a greeting first; resolve only when OUR payload comes back.
    const echo = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 6000);
      ws.addEventListener("message", (e) => { if (String(e.data) === sent) { clearTimeout(t); resolve(String(e.data)); } });
      ws.send(sent);
    });
    try { ws.close(1000); } catch {}
    return Response.json({ ok: echo === sent, echo });
  }
};
`;
const AGENT_VERSION = "skeleton-2";

// A confined agent run BY the DO (host.load). It calls back into its own capability host via env.ITX — an
// intra-DO re-entrancy probe: whoami (built-in) + invokeCapability (falls back to the DummyControlPlane).
const ITX_CALLBACK_AGENT = /* js */ `
export default {
  async fetch(request, env) {
    // env.ITX is a stub to the agent's OWN capability host (the DO). These calls re-enter that DO.
    const who = await env.ITX.invokeCapability("itx.whoami");
    const auth = await env.ITX.invokeCapability("itx.auth.gate");
    return Response.json({ who, auth, ranInContext: true });
  }
};
`;

// The EGRESS door (project level): substitute the project's own secrets, then delegate outward to the
// configured fallback. WS-safe (it only rewrites headers). Minted per request via ctx.exports and wired as
// the confined agent's globalOutbound.
export class EgressEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  async fetch(request: Request): Promise<Response> {
    const projectId = this.ctx.props.projectId;
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV ? this.env.SECRETS_KV.get(`secret:${projectId}:${name}`) : null,
    );
    return resolveFallback(this.ctx, this.env, parseAppConfig(this.env.APP_CONFIG)).fetch(sub);
  }
}

// The SOLO fallback: a whole control plane, trivially. It would substitute platform/first-party secrets
// (none in solo), then hit terminal (the real internet). Its `invokeCapability` is the capability fallthrough
// (auth → ok). See target-core §3.4 (why a whole DummyControlPlane, not a DummyAuth).
export class DummyControlPlane extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // (platform-secret substitution would go here; none in solo) → terminal, which carries WS.
    return fetch(request);
  }
  async invokeCapability(callPath: string, _args?: unknown[]): Promise<unknown> {
    if (callPath === "itx.auth.gate") return { ok: true };
    throw new Error(`DummyControlPlane: no capability "${callPath}"`);
  }
}

type LoopbackStub = Fetcher & ((o: { props: unknown }) => Fetcher);
type CtxWithExports = { exports: Record<string, LoopbackStub> };

/** Resolve the configured fallback to a Fetcher (target-core §3.4). Solo → the DummyControlPlane loopback.
 *  A ctx.exports entrypoint stub is itself a Fetcher (the default instance); you only CALL it to pass props. */
function resolveFallback(ctx: unknown, env: Env, cfg: AppConfig): Fetcher {
  const f = cfg.fallback;
  if (f.via === "loopback-entrypoint") return (ctx as CtxWithExports).exports[f.entrypoint];
  if (f.via === "service-binding") return (env as unknown as Record<string, Fetcher>)[f.binding];
  return { fetch: (r: Request) => fetch(r) } as unknown as Fetcher; // terminal
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── INGRESS WS → the itx DO (proves a DO-stub fetch carries the 101) ──
    if (
      url.pathname === "/ws" ||
      (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
    ) {
      const name = url.searchParams.get("ctx") ?? "prj_demo";
      return env.ITX_HOST.getByName(name).fetch(request);
    }

    // ── the capability model: provide a mount, then invoke a callPath (built-in / local / fallback) ──
    if (url.pathname === "/provide") {
      const ctxName = url.searchParams.get("ctx") ?? "prj_demo";
      const path = url.searchParams.get("path") as `itx.${string}` | null;
      if (!path) return Response.json({ ok: false, error: "missing ?path=itx.*" }, { status: 400 });
      const expression = url.searchParams.get("expression");
      const value = url.searchParams.get("value");
      const input = expression
        ? ({ path, type: "itx-expression", expression: expression as `itx.${string}` } as const)
        : ({ path, type: "static", value } as const);
      try {
        return Response.json(await env.ITX_HOST.getByName(ctxName).provideCapability(input));
      } catch (e) {
        return Response.json({ ok: false, error: String((e as Error).message) });
      }
    }
    // ── execution in the DO: host.load runs a confined agent whose env.ITX is a self-stub to its host ──
    if (url.pathname === "/load") {
      const ctxName = url.searchParams.get("ctx") ?? "prj_demo";
      try {
        return await env.ITX_HOST.getByName(ctxName).load(ITX_CALLBACK_AGENT);
      } catch (e) {
        return Response.json(
          { ok: false, error: String((e as Error).message ?? e) },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/call") {
      const ctxName = url.searchParams.get("ctx") ?? "prj_demo";
      const path = url.searchParams.get("path") ?? "itx.whoami";
      try {
        return Response.json({
          ok: true,
          value: await env.ITX_HOST.getByName(ctxName).invokeCapability(path),
        });
      } catch (e) {
        return Response.json({ ok: false, error: String((e as Error).message) });
      }
    }

    // ── deterministic proof that the egress middleware substitutes (no log-tail needed) ──
    if (url.pathname === "/egress-debug") {
      const req = new Request("https://example.test/", {
        headers: { Authorization: "Bearer {{secret:project:demo}}" },
      });
      const sub = await substituteHeaderSecrets(req, "project", (n) =>
        env.SECRETS_KV ? env.SECRETS_KV.get(`secret:prj_demo:${n}`) : null,
      );
      return Response.json({
        substituted: sub !== req,
        authorizationHeader: sub.headers.get("Authorization"),
      });
    }

    // ── EGRESS WS proof → load a confined agent that dials an outbound WS back to our own /ws ──
    if (url.pathname === "/egress-test") {
      // Cloudflare fetch() takes an https:// URL + `Upgrade: websocket` (NOT a ws:// scheme). External echo
      // (a worker can't WS its own hostname — loop protection); ingress WS is proven separately against /ws.
      const target = url.searchParams.get("target") ?? "https://echo.websocket.org/";
      const entry = (ctx as unknown as CtxWithExports).exports.EgressEntrypoint({
        props: { projectId: "prj_demo" },
      });
      const worker = env.LOADER.get(`egress-agent:${AGENT_VERSION}`, () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "a.js",
        modules: { "a.js": EGRESS_WS_AGENT },
        env: {}, // the confined agent sees NOTHING but globalOutbound
        globalOutbound: entry, // its fetch → the egress door → fallback → terminal
      }));
      return worker
        .getEntrypoint()
        .fetch(new Request(`${url.origin}/?target=${encodeURIComponent(target)}`));
    }

    return new Response(
      "project-worker walking skeleton (solo)\n  GET /ws          ingress WS echo\n  GET /egress-test egress WS through the whole stack\n",
      { headers: { "content-type": "text/plain" } },
    );
  },
};
