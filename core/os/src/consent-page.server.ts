// The consent page's server side (routes/oauth2.auth.tsx). Every action runs as the browser's
// issuer session: consent.ts decides what the authorization request may show and grant, and
// session.ts creates organizations and projects exactly as `/api` does. `authorization` is the raw
// authorization query (`?client_id=…`), passed on unchanged.

import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { errorCode, withTimeout } from "iterate/lib";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import { ConsentRpcTarget } from "./consent.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { templates } from "./generated/config-templates.js";
import { signInHref } from "./login-search.ts";
import type { Env } from "./env.ts";
import { SessionRpcTarget, SessionTeardown } from "./session.ts";

/** The browser's issuer session — the only grant that may approve access or act on the consent
 *  page. Anything else (no cookie, an ended session) is not signed in to the issuer. */
async function issuerSignIn(request: Request, env: Env) {
  const signedIn = await browserAuthorization(env, request);
  if (signedIn?.grant?.kind !== "issuer") return null;
  return { ...signedIn, grant: signedIn.grant };
}

/** Sign in first and come back to this authorization, leading with the way to sign in its
 *  client's link suggested (`provider_hint`, which iterate/app-server.ts `/.auth/login` passes on). */
function signInToAuthorize(authorization: string) {
  return signInHref(
    `/oauth2/auth${authorization}`,
    new URLSearchParams(authorization).get("provider_hint"),
  );
}

/** How long the page waits on the issuer session's admission before it says the person's account
 *  is still being set up: a new person's account can take seconds to start (oauth.ts
 *  `accountStateOf`), and a returning person's admission takes tens of milliseconds. */
const ACCOUNT_SETUP_WAIT_MS = 4_000;

/** What the page shows for this authorization request. A request the provider refuses with a
 *  validated redirect goes back to the client at once. An admission still unanswered after
 *  `ACCOUNT_SETUP_WAIT_MS`, or one the platform failed (UNAVAILABLE), is `setting-up`: the page
 *  says the account is still being set up and asks again (setting-up-account.tsx). Nothing is
 *  granted meanwhile. */
export async function describeConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authorization: string,
) {
  const addresses = platformAddressesOf(env, request);
  const signedIn = await withTimeout(
    issuerSignIn(request, env),
    ACCOUNT_SETUP_WAIT_MS,
    "the issuer session's admission",
  ).catch((error: unknown) => {
    const code = errorCode(error);
    if (code !== "TIMEOUT" && code !== "UNAVAILABLE") throw error;
    console.info({ event: "consent.account-setting-up", code });
    return "setting-up" as const;
  });
  if (signedIn === "setting-up")
    return { view: { kind: "setting-up" as const }, platformOrigin: addresses.platformOrigin };
  if (!signedIn) throw redirect({ href: signInToAuthorize(authorization) });
  const view = await new ConsentRpcTarget(env, ctx, signedIn.grant, addresses, {
    admittedThisRequest: true,
  }).describe(authorization);
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
  const signedIn = await issuerSignIn(request, env);
  if (!signedIn) throw redirect({ href: signInToAuthorize(input.authorization) });
  const teardown = new SessionTeardown();
  const session = new SessionRpcTarget(
    {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      controlPlane: new ControlPlane(env),
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
        : (await session.organizations.create({ name: input.organization.name })).id;
    // A person's project starts as the dash starts one when they pick nothing: from
    // core/configs/default, which every build lists first (scripts/build.ts). Its root context is
    // the platform's to hold, not this page's.
    await session.projects.create({
      project: input.slug,
      orgId,
      configRepoTemplate: templates[0].reference,
    });
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
  /** the user id of the person a platform admin picked under "Sign in as someone else…"
   *  (consent.ts `approve`) */
  impersonate: z.string().min(1).optional(),
});

/** POST /oauth2/auth — the page's Authorize form, posted to the authorization URL itself so the
 *  query is the one the client sent. The browser follows the 303 to the client's redirect URI,
 *  whatever its scheme. A request that cannot be approved as posted returns to the page, which
 *  describes it afresh. The form is read before the issuer session is admitted: the approval reads
 *  the session no second time (`admittedThisRequest`), so no body the client sends slowly may
 *  stand between that admission and the grant it approves. */
export async function approveConsentForm(request: Request, env: Env, ctx: ExecutionContext) {
  // The issuer's cookie approves a grant — someone else's, for an admin — so this form wants its
  // Origin present, not only not foreign (issuer-pages.ts): a browser always sends one on a form
  // POST, and nothing but the page itself ever posts here.
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("403: a consent needs this page's own Origin\n", { status: 403 });
  const authorization = new URL(request.url).search;
  const seeOther = (location: string) =>
    new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
  const form = await request.formData().catch(() => null);
  const signedIn = await issuerSignIn(request, env);
  if (!signedIn) return seeOther(signInToAuthorize(authorization));
  const approval = ConsentApproval.safeParse({
    project: form?.getAll("project"),
    scope: form?.getAll("scope"),
    impersonate: form?.get("impersonate") ?? undefined,
  });
  if (!approval.success) return new Response("Invalid consent form", { status: 400 });
  const addresses = platformAddressesOf(env, request);
  const consent = new ConsentRpcTarget(env, ctx, signedIn.grant, addresses, {
    admittedThisRequest: true,
  });
  const approved = await consent.approve({
    query: authorization,
    projects: approval.data.project,
    scopes: approval.data.scope,
    impersonate: approval.data.impersonate,
  });
  return seeOther("redirectTo" in approved ? approved.redirectTo : `/oauth2/auth${authorization}`);
}
