import { newWorkersRpcResponse, RpcSession, WebSocketTransport } from "capnweb";
import type { Env } from "./env.ts";
import { ConsentRpcTarget } from "./consent.ts";
import { GrantsRpcTarget } from "./grants.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { holdGrantLease } from "./project-host-lease.ts";
import { authorizationForToken, recordGrantUse, type Authorization } from "./oauth.ts";
import {
  IterateRpcTarget,
  SessionTeardown,
  type SessionAuthority,
  type SessionInput,
} from "./session.ts";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";

/** Cap’n Web always terminates at /api in the stateless edge. Its root is an
 * already-authorized session — or, on a socket opened BARE (api.ts: no credential on the upgrade),
 * a root that authorizes IN-BAND: `authenticate({ type: "bearer", token })` runs the token through
 * the same gate and binds this transport to its grant. Authority never comes from a later
 * caller-supplied actor; a transport carries one grant for its life. */
export async function rpcResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  auth: Authorization | null,
) {
  // THE PLATFORM ADDRESSES this transport reached the platform at (app-config.ts): every address
  // and every caller stamp downstream is at them.
  const addresses = platformAddressesOf(env, request);
  const { platformOrigin } = addresses;
  const projects = new Set<string>();
  const teardown = new SessionTeardown();
  const authorityOf = (authorization: Authorization): SessionAuthority => ({
    principal: authorization.principal,
    grant: authorization.grant?.grantId,
    reach: authorization.reach,
    grants: new GrantsRpcTarget(env, authorization, addresses),
    scopes: authorization.grant?.scope,
    ...(authorization.grant?.kind === "issuer" && {
      consent: new ConsentRpcTarget(env, ctx, authorization.grant, addresses, {
        admittedThisRequest: false,
      }),
    }),
  });
  // THE GRANT THIS TRANSPORT CARRIES: the upgrade's (resolved by the gate before this call), or the
  // one an in-band `authenticate` binds — once; a second token on the same socket is refused, a
  // refreshed token is a new socket (the guard below closes this one at the grant's expiry).
  let bound = auth;
  let binding = false; // an `authenticate` in flight: a second one on the same socket is refused at once
  let bindSocket: ((authorization: Authorization) => void) | undefined;
  const input: SessionInput = {
    contextNamespace: env.ITERATE_CONTEXT,
    waitUntil: (promise) => ctx.waitUntil(promise),
    // A read unanswered in 3 s is a retryable ControlPlaneUnavailableError, not a call held until
    // the transport gives up: the singleton's slowest prd answer was 1.25 s (measured 2026-09-24),
    // and 3 s is what a project host's admission waits before a copy stands in
    // (last-known-project.ts).
    controlPlane: new ControlPlane(env.CONTROL_PLANE, { readDeadlineMs: 3_000 }),
    appConfig: appConfigOf(env),
    platformOrigin,
    onProjectAccess: (projectId) => projects.add(projectId),
    resolveBearer: async (token) => {
      // Claimed BEFORE the gate is awaited: two tokens racing on one socket cannot both bind.
      if (bound || binding) throw new Error("This transport already carries a session");
      binding = true;
      try {
        const authorization = await authorizationForToken(env, token, addresses, "api");
        if (!authorization) return null;
        if (authorization.grant) ctx.waitUntil(recordGrantUse(env, authorization.grant));
        bound = authorization;
        bindSocket?.(authorization);
        return authorityOf(authorization);
      } finally {
        binding = false;
      }
    },
  };
  const root = new IterateRpcTarget(input, teardown, auth && authorityOf(auth));
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    try {
      return await newWorkersRpcResponse(request, root, {
        onCall: (_call, invoke) => {
          const grant = bound?.grant;
          if (grant && grant.expiresAt <= Date.now()) throw new Error("Session expired");
          return invoke();
        },
      });
    } finally {
      teardown.disposeAll();
    }
  }
  // The operator credential (no grant) has no expiry or revocation to guard.
  if (auth && !auth.grant) return newWorkersRpcResponse(request, root);

  const pair = new WebSocketPair();
  const socket = pair[0];
  socket.accept();
  // This public transport accepts DOM WebSocket's type; Workers supplies the same
  // event/send/close interface, without the browser-only prototype members.
  const transport = new WebSocketTransport(socket as unknown as WebSocket);
  let stopped = false;
  let release = () => {}; // the grant's lease (project-host-lease.ts), once one is bound
  let cancelReceive: ((error: unknown) => void) | undefined;
  let recordedAt = Date.now();

  function stop(error: Error) {
    if (stopped) return;
    stopped = true;
    release();
    teardown.disposeAll();
    cancelReceive?.(error); // End receive immediately; no dependency on the peer's close reply.
    cancelReceive = undefined;
    if (socket.readyState === WebSocket.OPEN) transport.abort(error);
  }
  function check() {
    if (stopped) throw new Error("Session expired or revoked");
  }
  // Hold the socket to its grant's lease: at once for the upgrade's, at `authenticate` for an
  // in-band one. A bare socket has nothing to expire until then.
  bindSocket = (authorization) => {
    const grant = authorization.grant;
    if (!grant || stopped) return;
    release = holdGrantLease(
      env,
      grant,
      async () => {
        // THE PROJECTS THIS SOCKET HOLDS at this tick. One admitted while the reads are in flight
        // passed `reachesProject` itself and is the next tick's to re-check — measured against a
        // list read before it existed, it would close a live socket for nothing. A socket holding
        // no project has no membership to re-check and reads none.
        const held = [...projects];
        if (!held.length) return true;
        const reachable = await input.controlPlane.reachableProjects(authorization.reach, held);
        const reachableIds = new Set(reachable.map((project) => project.id));
        return held.every((id) => reachableIds.has(id));
      },
      (reason) => stop(new Error(reason)),
      "live-authorization",
    );
  };
  socket.addEventListener("close", () => stop(new Error("Session closed")), { once: true });
  socket.addEventListener("error", () => stop(new Error("Session connection failed")), {
    once: true,
  });
  if (auth) bindSocket(auth);
  new RpcSession(
    {
      send(message) {
        check();
        transport.send(message);
      },
      receive() {
        check();
        return new Promise<string>((resolve, reject) => {
          cancelReceive = reject;
          void transport
            .receive()
            .then((message) => {
              cancelReceive = undefined;
              // Guard every frame, including forwarded capabilities which bypass onCall.
              check();
              const grant = bound?.grant;
              if (grant && Date.now() - recordedAt >= 60_000) {
                recordedAt = Date.now();
                ctx.waitUntil(recordGrantUse(env, grant));
              }
              resolve(message);
            }, reject)
            .catch(reject);
        });
      },
      abort(reason) {
        stop(reason instanceof Error ? reason : new Error(String(reason)));
      },
    },
    root,
    {
      onCall: (_call, invoke) => {
        check();
        return invoke();
      }, // invoke synchronously: preserve e-order.
    },
  );
  return new Response(null, { status: 101, webSocket: pair[1] });
}
