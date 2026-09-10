import { newWorkersRpcResponse } from "capnweb";
import type { Env } from "./control-plane.ts";
import { directory } from "./directory.ts";
import type { Authorization } from "./oauth.ts";
import { Session, SessionTeardown, type SessionInput } from "./session.ts";
import { appConfigOf } from "./worker.ts";

/** Cap’n Web always terminates at /api in the stateless edge. Its root is an
 * already-authorized session; authority never comes from a later caller-supplied actor. */
export function rpcResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  auth: Authorization,
) {
  const input: SessionInput = {
    contextNamespace: env.ITERATE_CONTEXT,
    waitUntil: (promise) => ctx.waitUntil(promise),
    directory: directory(env.DB),
    request,
    appConfig: appConfigOf(env),
    secretsKv: env.SECRETS_KV,
  };
  return newWorkersRpcResponse(
    request,
    new Session(
      input,
      new SessionTeardown(),
      auth.principal,
      auth.reach,
      auth.grant ? null : input,
    ),
  );
}
