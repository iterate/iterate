import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { withAuthenticationResponseHeaders } from "@iterate-com/auth/server";
import { env as workerEnv } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import type { Stream } from "iterate/sdk";
import { parseStreamRpcRequest } from "./lib/stream-rpc.ts";
import { parseConfig } from "./config.ts";
import { createStreamsIterateAuth, resolveRequestAdmin } from "./iterate-auth.ts";
import { trustedInternalAuthContext } from "~/auth.ts";
import { STREAM_DURABLE_OBJECT_STUB, StreamRpcTarget } from "~/rpc-targets.ts";
import { resolveStreamPath } from "~/domains/streams/utils.ts";

export { StreamDurableObject } from "~/domains/streams/stream-durable-object.ts";

/**
 * The capnweb surface this playground serves at `/api/streams`.
 *
 * It wraps the itx `StreamRpcTarget` with `trustedInternalAuthContext()`:
 * every caller who gets past the door below runs with the trusted-internal
 * (admin) authority instead of walking through the real deployment's
 * `UnauthenticatedOs.authenticate()` door. That door is iterate-auth: on
 * deployed envs, only iterate admins (session cookie or bearer access token)
 * reach the RPC surface or the UI. Local dev (no iterateAuth config) stays
 * the historical auth-less playground.
 *
 * `kill()`/`reset()` are playground-only operator verbs on top of the public
 * `Stream` capability — the sidebar's restart/reset experiments need them, and
 * itx deliberately keeps them off the public contract.
 */
class PlaygroundStreamRpcTarget extends StreamRpcTarget {
  override at(path: Parameters<Stream["at"]>[0]) {
    return new PlaygroundStreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: resolveStreamPath(this.props.path, path),
    });
  }

  /** Abort the stream DO; the durable log is kept and a woken event is appended on restart. */
  kill() {
    return this[STREAM_DURABLE_OBJECT_STUB].kill();
  }

  /** Wipe all stream DO storage, then abort — the next connection starts a fresh stream. */
  reset() {
    return this[STREAM_DURABLE_OBJECT_STUB].reset();
  }
}

function notAnAdminResponse(email: string | undefined): Response {
  const who = email ? ` as ${email}` : "";
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;display:grid;place-items:center;min-height:100svh;margin:0">
      <div style="max-width:24rem;text-align:center">
        <h1 style="font-size:1.1rem">Operator access required</h1>
        <p style="color:#666;font-size:0.9rem">You are signed in${who}, but the streams playground requires an iterate admin identity.</p>
        <p><a href="/api/iterate-auth/logout">Sign out</a></p>
      </div>
    </body></html>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/__internal/health") {
      const version = workerEnv.CF_VERSION_METADATA?.id ?? "unversioned";
      return new Response("ok", {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain",
          "x-iterate-worker-version": version,
        },
      });
    }

    // Parsed per request, NOT at module scope (matching apps/os): a fresh
    // DO-class worker's first deploy is a secrets-less bootstrap (see
    // scripts/lib/deploy-helpers.ts), and a module-scope parse would fail
    // Cloudflare's startup validation on that version before secrets land.
    const config = parseConfig(workerEnv);
    const auth = createStreamsIterateAuth(config, request.url);

    // The relying-party handler (login/callback/logout/session/…).
    const authResponse = (await auth?.fetch(request)) ?? null;
    if (authResponse) {
      return authResponse;
    }

    // Browser WebSockets cannot set headers, so /api/streams also accepts the
    // bearer as an `access_token` query param (RFC 6750 §2.3) — the lane the
    // node e2e uses for the browser-client tests. Real browsers ride the
    // session cookie on the upgrade instead.
    const queryToken =
      url.pathname === "/api/streams" ? url.searchParams.get("access_token") : null;
    const headers = new Headers(request.headers);
    if (queryToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${queryToken}`);
    }
    const admin = auth ? await resolveRequestAdmin({ auth, headers }) : null;
    const withAuthHeaders = (response: Response) =>
      admin ? withAuthenticationResponseHeaders(response, admin.responseHeaders) : response;

    if (url.pathname === "/api/streams") {
      if (auth && !admin?.isAdmin) {
        return withAuthHeaders(
          Response.json(
            {
              error: "unauthorized",
              message:
                "Authenticate with an iterate admin identity: sign in through /api/iterate-auth/login, or send an admin access token as `Authorization: Bearer <token>`.",
            },
            { status: 401 },
          ),
        );
      }
      const { projectId, path } = parseStreamRpcRequest({ url });
      return withAuthHeaders(
        await newWorkersRpcResponse(
          request,
          new PlaygroundStreamRpcTarget({
            auth: trustedInternalAuthContext(),
            projectId,
            path,
          }),
        ),
      );
    }

    // Page routes: send signed-out visitors through login and back; show
    // signed-in non-admins a sign-out page. Static assets never reach the
    // worker, and they carry nothing sensitive (client code only).
    if (auth && !admin?.isAdmin) {
      if (!admin?.authenticated) {
        const returnTo = `${url.pathname}${url.search}`;
        return withAuthHeaders(
          Response.redirect(
            `${url.origin}/api/iterate-auth/login?${new URLSearchParams({ return_to: returnTo })}`,
            302,
          ),
        );
      }
      return withAuthHeaders(notAnAdminResponse(admin.email));
    }

    // No COOP/COEP on purpose: the browser SQLite database uses wa-sqlite's OPFSCoopSyncVFS,
    // which needs no SharedArrayBuffer and no cross-origin isolation. (Isolation is what
    // made @sqlite.org/sqlite-wasm auto-install its async-proxy OPFS VFS and deadlock in
    // production builds.) Leaving it off also keeps OPFS working the same way
    // across Chrome, Edge, Safari and mobile Safari.
    const response = await handler.fetch(request, { context: {} });

    return withAuthHeaders(response);
  },
});
