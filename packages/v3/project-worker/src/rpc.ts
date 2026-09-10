import { newWorkersRpcResponse, RpcSession, WebSocketTransport } from "capnweb";
import type { Env } from "./control-plane.ts";
import { Grants } from "./grants.ts";
import { directory } from "./directory.ts";
import { authorizationOf, recordGrantUse, type Authorization } from "./oauth.ts";
import { Session, SessionTeardown, type SessionInput } from "./session.ts";
import { appConfigOf } from "./app-config.ts";

/** Cap’n Web always terminates at /api in the stateless edge. Its root is an
 * already-authorized session; authority never comes from a later caller-supplied actor. */
export async function rpcResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  auth: Authorization,
) {
  const projects = new Set<string>();
  const teardown = new SessionTeardown();
  const input: SessionInput = {
    contextNamespace: env.ITERATE_CONTEXT,
    waitUntil: (promise) => ctx.waitUntil(promise),
    directory: directory(env.DB),
    request,
    appConfig: appConfigOf(env),
    secretsKv: env.SECRETS_KV,
    onProjectAccess: (projectId) => projects.add(projectId),
  };
  const root = new Session(input, teardown, {
    principal: auth.principal,
    reach: auth.reach,
    projectDoors: auth.grant ? null : input,
    grants: new Grants(env, ctx, auth),
    scopes: auth.grant?.scope,
  });
  const grant = auth.grant;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    try {
      return await newWorkersRpcResponse(request, root, {
        onCall: (_call, invoke) => {
          if (grant && grant.expiresAt <= Date.now()) throw new Error("Session expired");
          return invoke();
        },
      });
    } finally {
      teardown.disposeAll();
    }
  }
  if (!grant) return newWorkersRpcResponse(request, root);

  const pair = new WebSocketPair();
  const socket = pair[0];
  socket.accept();
  // This public transport accepts DOM WebSocket's type; Workers supplies the same
  // event/send/close interface, without the browser-only prototype members.
  const transport = new WebSocketTransport(socket as unknown as WebSocket);
  let until = Math.min(Date.now() + 60_000, grant.expiresAt);
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
  const schedule = () => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => stop(new Error("Session authorization expired")),
      Math.max(0, until - Date.now()),
    );
    renewal = setTimeout(async () => {
      const started = Date.now();
      try {
        const current = await authorizationOf(env, grant);
        const reachable = new Set(
          (await input.directory.reachableProjects(auth.reach)).map((p) => p.id),
        );
        if (!current || [...projects].some((id) => !reachable.has(id))) {
          stop(new Error("Session revoked or project membership removed"));
          return;
        }
        if (stopped) return;
        until = Math.min(started + 60_000, grant.expiresAt);
        schedule();
      } catch (error) {
        console.error("oauth.live_authorization_failed", { grantId: grant.grantId, error });
        stop(new Error("Session authorization could not be renewed"));
      }
    }, 30_000);
  };
  socket.addEventListener("close", () => stop(new Error("Session closed")), { once: true });
  socket.addEventListener("error", () => stop(new Error("Session connection failed")), {
    once: true,
  });
  schedule();
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
              if (Date.now() - recordedAt >= 60_000) {
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
