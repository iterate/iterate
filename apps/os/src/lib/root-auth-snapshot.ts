import { createServerFn } from "@tanstack/react-start";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import type { AuthenticatedSession } from "@iterate-com/auth/server";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

export type RootAuthSnapshot = {
  authSession: PublicSessionResponse;
  iterateAuthIssuer: string | undefined;
  currentProjectHostSlug: string | null;
};

/**
 * Reads the request's authenticated session (resolved by the iterate auth
 * request middleware from signed JWT claims) without any auth-worker
 * roundtrip. During SSR this executes in-process; if a client navigation ever
 * misses the dehydrated cache it fetches from the OS worker instead of
 * treating the user as signed out.
 *
 * Lives outside routes/ and carries an explicit type on purpose: server
 * functions used by route files must not let route types recurse into Start's
 * Register interface (routeTree.gen.ts registers `router: typeof getRouter`
 * there, which depends on the route tree — a cycle, TS7022).
 */
export const fetchRootAuthSnapshot: () => Promise<RootAuthSnapshot> = createServerFn({
  method: "GET",
}).handler(async ({ context }): Promise<RootAuthSnapshot> => {
  return {
    authSession: toPublicSession(context.iterateAuthSession),
    iterateAuthIssuer: context.config.iterateAuth?.issuer,
    currentProjectHostSlug: resolveCurrentProjectHostSlug({
      baseUrl: context.config.baseUrl,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
      requestUrl: context.rawRequest?.url,
    }),
  };
});

function toPublicSession(session: AuthenticatedSession | null | undefined): PublicSessionResponse {
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    user: session.user,
    session: session.session,
  };
}

function resolveCurrentProjectHostSlug(input: {
  baseUrl: string | undefined;
  projectHostnameBases: string[];
  requestUrl: string | undefined;
}) {
  if (!input.requestUrl) return null;

  const dashboardHostname = input.baseUrl
    ? normalizeRequestHostname(new URL(input.baseUrl).hostname)
    : null;
  const requestHostname = normalizeRequestHostname(new URL(input.requestUrl).hostname);
  if (dashboardHostname && requestHostname === dashboardHostname) return null;

  return resolveProjectSlugFromHostname(requestHostname, input.projectHostnameBases) ?? null;
}
