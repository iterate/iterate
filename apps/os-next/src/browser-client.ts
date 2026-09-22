import { appAuth, appSession } from "iterate/next/app-server";
import { platformAddressesOf } from "./app-config.ts";
import { oauthResponse } from "./api.ts";
import type { Env } from "./control-plane.ts";
import { authorizationForToken } from "./oauth.ts";

/** Platform cookies never enter userspace or its outgoing requests. */
export function appCookies(cookie: string | null) {
  return (cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("__Host-itx-"))
    .join("; ");
}

/** The edge stamps app requests after the ordinary public token gate admits them. */
export async function browserAuthorization(env: Env, request: Request, ctx: ExecutionContext) {
  const session = appSession(env.BROWSER_SESSION, request);
  const token = await session?.bearer();
  if (!token) return null;
  const authorization = await authorizationForToken(
    env,
    ctx,
    token,
    platformAddressesOf(env, request),
  );
  if (!authorization) await session!.discard();
  return authorization;
}

export function browserClient(request: Request, env: Env, ctx: ExecutionContext) {
  const { platformOrigin, api } = platformAddressesOf(env, request);
  return appAuth(request, {
    sessions: env.BROWSER_SESSION,
    issuer: platformOrigin,
    resource: api,
    api: (request) => oauthResponse(request, env, ctx),
    ...(new URL(request.url).origin === platformOrigin && {
      loginPage: "/login",
      client: { name: "Iterate", logoUri: "/iterate-logo.svg" },
    }),
  });
}
