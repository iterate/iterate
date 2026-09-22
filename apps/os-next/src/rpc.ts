import { newWorkersRpcResponse, RpcSession, WebSocketTransport } from "capnweb";
import type { Env } from "./control-plane.ts";
import { Consent } from "./consent.ts";
import { Grants } from "./grants.ts";
import { directory } from "./directory.ts";
import {
  authorizationForToken,
  authorizationOf,
  recordGrantUse,
  type Authorization,
} from "./oauth.ts";
import {
  IterateRpcTarget,
  SessionTeardown,
  type SessionAuthority,
  type SessionInput,
} from "./session.ts";
import { appConfigOf, platformOriginOf } from "./app-config.ts";

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
  // THE PLATFORM ORIGIN this transport reached the platform on (app-config.ts): every address and
  // every caller stamp downstream is at it.
  const platformOrigin = platformOriginOf(appConfigOf(env), request);
  const projects = new Set<string>();
  const teardown = new SessionTeardown();
  const authorityOf = (authorization: Authorization): SessionAuthority => ({
    principal: authorization.principal,
    grant: authorization.grant?.grantId,
    reach: authorization.reach,
    grants: new Grants(env, ctx, authorization, platformOrigin),
    scopes: authorization.grant?.scope,
    ...(authorization.grant?.kind === "issuer" && {
      consent: new Consent(env, ctx, authorization.grant, platformOrigin),
    }),
  });
  // THE GRANT THIS TRANSPORT CARRIES: the upgrade's (resolved by the gate before this call), or the
  // one an in-band `authenticate` binds — once; a second token on the same socket is refused, a
  // refreshed token is a new socket (the guard below closes this one at the grant's expiry).
  let bound: Authorization | null = auth;
  let binding = false; // an `authenticate` in flight: a second one on the same socket is refused at once
  let bindSocket: ((authorization: Authorization) => void) | undefined;
  const input: SessionInput = {
    contextNamespace: env.ITERATE_CONTEXT,
    waitUntil: (promise) => ctx.waitUntil(promise),
    directory: directory(env.DB),
    appConfig: appConfigOf(env),
    platformOrigin,
    onProjectAccess: (projectId) => projects.add(projectId),
    resolveBearer: async (token) => {
      // Claimed BEFORE the gate is awaited: two tokens racing on one socket cannot both bind.
      if (bound || binding) throw new Error("This transport already carries a session");
      binding = true;
      try {
        const authorization = await authorizationForToken(env, ctx, token, platformOrigin);
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
  let until = Infinity; // a bare socket has nothing to expire until a grant is bound
  let stopped = false;
  let renewal: ReturnType<typeof setTimeout>;
  let deadline: ReturnType<typeof setTimeout>;
  let cancelReceive: ((error: unknown) => void) | undefined;
  let recordedAt = Date.now();

  function stop(error: Error) {
    if (stopped) return;
    stopped = true;
    clearTimeout(renewal);
    clearTimeout(deadline);
    teardown.disposeAll();
    cancelReceive?.(error); // End receive immediately; no dependency on the peer's close reply.
    cancelReceive = undefined;
    if (socket.readyState === WebSocket.OPEN) transport.abort(error);
  }
  function check() {
    if (stopped || Date.now() >= until) {
      const error = new Error("Session expired or revoked");
      stop(error);
      throw error;
    }
  }
  const schedule = (authorization: Authorization, grant: NonNullable<Authorization["grant"]>) => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => stop(new Error("Session authorization expired")),
      Math.max(0, until - Date.now()),
    );
    renewal = setTimeout(async () => {
      const started = Date.now();
      // THE PROJECTS THIS SOCKET HOLDS at this tick. One admitted while the reads are in flight
      // passed `reachesProject` itself and is the next tick's to re-check — measured against a list
      // read before it existed, it would close a live socket for nothing. The grant read and the
      // membership read are independent (both take the bind-time grant), so they run together; a
      // socket holding no project has no membership to re-check and reads none.
      const held = [...projects];
      try {
        const [current, reachable] = await Promise.all([
          authorizationOf(env, grant),
          held.length ? input.directory.reachableProjects(authorization.reach) : [],
        ]);
        const reachableIds = new Set(reachable.map((project) => project.id));
        if (!current || held.some((id) => !reachableIds.has(id))) {
          stop(new Error("Session revoked or project membership removed"));
          return;
        }
        if (stopped) return;
        until = Math.min(started + 60_000, grant.expiresAt);
        schedule(authorization, grant);
      } catch (error) {
        console.error("oauth.live_authorization_failed", { grantId: grant.grantId, error });
        stop(new Error("Session authorization could not be renewed"));
      }
    }, 30_000);
  };
  // Bind the guard to a grant: at once for the upgrade's, at `authenticate` for an in-band one.
  bindSocket = (authorization) => {
    const grant = authorization.grant;
    if (!grant || stopped) return;
    until = Math.min(Date.now() + 60_000, grant.expiresAt);
    schedule(authorization, grant);
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
