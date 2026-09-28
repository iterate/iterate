// sign-in-as-test-person.ts — A PLATFORM ADMIN SIGNS THE ISSUER SESSION IN AS A TEST PERSON: the
// sign-in page's answer to a link that names one (`/login?login_hint=pr<N>@preview.iterate.test`, a
// PR body's `Sign in ↗` for an app with no OAuth client of its own: scripts/preview-config.ts
// `proxiedAppSignInLink`). Under paths ingress such an app runs on the issuer's own session, so this
// is the consent page's "Sign in as someone else…" (consent.ts `#impersonate`) for the issuer
// itself, held tighter:
//   - only a person under `login.testEmailDomain`, which prd does not set, so never on prd;
//   - only someone already on the platform, and not the admin;
//   - only an admin (app-config.ts `admins`) signed in as themselves, never from a session that is
//     already someone else's.
// The page's offer (`testPersonOffer`) grants nothing: the POST (`signInAsTestPerson`) checks it all
// again against the browser's live session. The new session is the person's, for an hour
// (`IMPERSONATION_MS`), with the admin beside them on every call (`impersonatedBy`), and both
// accounts record it before the browser gets its cookie. Under paths a project's own pages share
// this origin, which is why `admins` beside paths ingress is refused off a preview or local dev
// (app-config.ts).

import { appSession } from "iterate/app-server";
import type { Impersonation } from "./account/contract.ts";
import { appConfigOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { isAdmin, type Authorization } from "./oauth.ts";
import { appendPlatformFacts } from "./session.ts";

/** A link's `login_hint` when it names someone under this deployment's test email domain: the only
 *  hint the sign-in page acts on. Null on prd, which has no such domain. */
export function testPersonHint(env: Env, hint: string | undefined): string | null {
  const domain = appConfigOf(env).login.testEmailDomain;
  const email = hint?.trim().toLowerCase();
  if (!domain || !email?.endsWith(`@${domain}`)) return null;
  return email;
}

/** The person the sign-in page offers `authorization`'s admin to sign in as, for a link's `hint`:
 *  see the rules at the top. Null when there is no such offer. */
export async function testPersonOffer(
  env: Env,
  authorization: Authorization | null,
  hint: string | undefined,
): Promise<{
  admin: { userId: string; email: string; grantId: string };
  person: UserRecord;
} | null> {
  const email = testPersonHint(env, hint);
  const grant = authorization?.grant;
  if (!email || grant?.kind !== "issuer" || grant.impersonatedBy || !isAdmin(env, grant.email))
    return null;
  const person = await new ControlPlane(env).getUser(email);
  if (!person || person.id === grant.userId) return null;
  return { admin: grant, person };
}

/** The sign-in page's "Sign in as <person> for an hour" (`POST /login` with `sign_in_as`): the
 *  browser's issuer session becomes the person's, the admin's own ended. `{ error }` when the
 *  browser's session may not do it, or the sign-in failed on the platform's side. */
export async function signInAsTestPerson(
  env: Env,
  request: Request,
  email: string,
  next: string,
): Promise<{ setCookie: string; location: string } | { error: string }> {
  const offer = await testPersonOffer(env, await browserAuthorization(env, request), email);
  if (!offer)
    return {
      error: `Only a platform admin, signed in as themselves, can sign in as ${email} here.`,
    };
  const { admin, person } = offer;
  const impersonatedBy = { actor: admin.userId, email: admin.email };
  const session = await startIssuerSession(env, request, person, next, { impersonatedBy });
  if ("error" in session) return session;
  // the records keep the grant's id, never the cookie, so either person can find and end it
  const payload = {
    grantId: session.grant.grantId,
    target: { userId: person.id, email: person.email },
    impersonatedBy,
    clientId: session.grant.clientId,
    clientName: "iterate",
    resource: "api",
    scopes: session.grant.scope,
    projects: null,
    expiresAt: session.grant.deadline,
  } satisfies Impersonation;
  const caller = { principal: impersonatedBy, grant: admin.grantId };
  await Promise.all([
    appendPlatformFacts(
      env.ITERATE_CONTEXT,
      { account: person.id },
      { type: "events.iterate.com/account/impersonation-started", payload },
      caller,
    ),
    appendPlatformFacts(
      env.ITERATE_CONTEXT,
      { account: admin.userId },
      { type: "events.iterate.com/account/impersonation-performed", payload },
      caller,
    ),
  ]);
  // The admin's own session in this browser: the new cookie replaces its cookie, so it is ended
  // at the issuer rather than left in their Sessions for thirty days with no browser holding it.
  const replaced = appSession(env.BROWSER_SESSION, request);
  await replaced?.end().catch(async (error: unknown) => {
    console.warn({
      event: "sign-in-as-test-person.admin-session-not-ended",
      message: String(error),
    });
    await replaced.discard();
  });
  console.info({
    event: "sign-in-as-test-person.signed-in",
    email: person.email,
    impersonatedBy: admin.email,
  });
  return { setCookie: session.setCookie, location: session.location };
}
