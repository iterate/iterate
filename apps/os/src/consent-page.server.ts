// The consent page's server side (routes/oauth2.auth.tsx). Every action runs as the browser's
// issuer session: consent.ts decides what the authorization request may show and grant, and
// session.ts creates organizations and projects exactly as `/api` does. `authorization` is the raw
// authorization query (`?client_id=…`), passed on unchanged.

import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { errorCode } from "iterate/next/lib";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import { ConsentRpcTarget } from "./consent.ts";
import { directory } from "./directory.ts";
import { loginSearchOf } from "./login-search.ts";
import type { Env } from "./env.ts";
import { SessionRpcTarget, SessionTeardown } from "./session.ts";

/** Sign in first, and come back to this very authorization request. */
function signInHref(authorization: string) {
  return `/login?${new URLSearchParams({ next: `/oauth2/auth${authorization}` })}`;
}

/** The browser's issuer session — the only grant that may approve access or act on the consent
 *  page. Anything else (no cookie, an ended session) is not signed in to the issuer. */
async function issuerSignIn(request: Request, env: Env, ctx: ExecutionContext) {
  const signedIn = await browserAuthorization(env, request, ctx);
  if (signedIn?.grant?.kind !== "issuer") return null;
  return { ...signedIn, grant: signedIn.grant };
}

/** What the page shows for this authorization request. A request the provider refuses with a
 *  validated redirect goes back to the client at once. */
export async function describeConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authorization: string,
) {
  const signedIn = await issuerSignIn(request, env, ctx);
  if (!signedIn) throw redirect({ href: signInHref(authorization) });
  const addresses = platformAddressesOf(env, request);
  const view = await new ConsentRpcTarget(env, ctx, signedIn.grant, addresses).describe(
    authorization,
  );
  if (view.kind === "redirect") throw redirect({ href: view.location });
  return { view, platformOrigin: addresses.platformOrigin };
}

export const NewConsentProject = z.object({
  authorization: z.string(),
  slug: z.string().trim().min(1),
  /** one of the person's organizations, or the name of a new one */
  organization: z.union([
    z.object({ id: z.string().min(1) }),
    z.object({ name: z.string().trim().min(1) }),
  ]),
});

/** Create a project on the consent page — in a new organization when the person named one. A
 *  refused project still reports the organization made for it, so the retry uses it; a session
 *  that has ended is redirected to sign in again. */
export async function createConsentProject(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  input: z.infer<typeof NewConsentProject>,
): Promise<{ orgId?: string; error?: string }> {
  const signedIn = await issuerSignIn(request, env, ctx);
  if (!signedIn)
    throw redirect({
      to: "/login",
      search: loginSearchOf({ next: `/oauth2/auth${input.authorization}` }),
    });
  const teardown = new SessionTeardown();
  const session = new SessionRpcTarget(
    {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      directory: directory(env.DB),
      appConfig: appConfigOf(env),
      platformOrigin: platformAddressesOf(env, request).platformOrigin,
    },
    teardown,
    {
      principal: signedIn.principal,
      grant: signedIn.grant.grantId,
      reach: signedIn.reach,
      scopes: signedIn.grant.scope,
    },
  );
  let orgId: string | undefined;
  try {
    orgId =
      "id" in input.organization
        ? input.organization.id
        : (await session.createOrg(input.organization.name)).id;
    // The new project's root context is the platform's to hold, not this page's.
    await session.projects.create({ project: input.slug, orgId });
    return { orgId };
  } catch (error) {
    const code = errorCode(error);
    if (code !== "INVALID_INPUT" && code !== "PROJECT_NAME_TAKEN" && code !== "FORBIDDEN")
      throw error;
    return { orgId, error: error instanceof Error ? error.message : String(error) };
  } finally {
    teardown.disposeAll();
  }
}

const ConsentApproval = z.object({
  project: z.array(z.string()),
  scope: z.array(z.string()),
});

/** POST /oauth2/auth — the page's Authorize form, posted to the authorization URL itself so the
 *  query is the one the client sent. The browser follows the 303 to the client's redirect URI,
 *  whatever its scheme. A request that cannot be approved as posted returns to the page, which
 *  describes it afresh. */
export async function approveConsentForm(request: Request, env: Env, ctx: ExecutionContext) {
  const authorization = new URL(request.url).search;
  const seeOther = (location: string) =>
    new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
  const signedIn = await issuerSignIn(request, env, ctx);
  if (!signedIn) return seeOther(signInHref(authorization));
  const form = await request.formData().catch(() => null);
  const approval = ConsentApproval.safeParse({
    project: form?.getAll("project"),
    scope: form?.getAll("scope"),
  });
  if (!approval.success) return new Response("Invalid consent form", { status: 400 });
  const consent = new ConsentRpcTarget(env, ctx, signedIn.grant, platformAddressesOf(env, request));
  const approved = await consent.approve({
    query: authorization,
    projects: approval.data.project,
    scopes: approval.data.scope,
  });
  return seeOther("redirectTo" in approved ? approved.redirectTo : `/oauth2/auth${authorization}`);
}
