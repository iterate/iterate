import type { Context } from "hono";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { auth } from "./auth.ts";
import { db } from "./db/index.ts";
import { config, type CloudflareEnv } from "./env.ts";
import { TEST_OTP_CODE } from "./email.ts";
import { appendSetCookieHeaders } from "./logout.ts";
import { resolveTestLoginRequest } from "./test-login-request.ts";
import { parseStringArray } from "./db/helpers.ts";
import {
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
  insertMembership,
  insertOrganization,
  listOrganizationsForUser,
  listProjectsForUser,
  listSeededOAuthClientRedirectUris,
} from "./db/queries/index.ts";
import { generateId } from "./id.ts";
import { createProject } from "./project-directory.ts";
import type { Variables } from "./utils/hono.ts";

// One-click sign-in for test addresses: GET /test-login?email=pr123+test@nustom.com
// completes the fixed-test-OTP flow server-side (the same better-auth sign-in a
// human drives on /login with code 424242), ensures the user has an org and a
// project so the OAuth authorize that follows never parks on /project-access,
// and redirects with the session cookie set.
//
// This grants nothing the fixed OTP doesn't already grant — it removes typing,
// not a wall. Availability is the same double gate as the OTP itself:
// `fixedTestOtpEnabled` is a build-time envs.ts flag (never true in
// production, `z.boolean().default(false)` fails closed) and the address must
// be `*+test@nustom.com` (shouldUseTestOtp). Preview PR comments link here
// (scripts/preview/preview.ts) and the preview deploy visits it once to seed
// user+org+project — see tasks/preview-one-click-login.md.

export async function handleTestLogin(
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) {
  const resolved = resolveTestLoginRequest({
    url: new URL(c.req.url),
    emailOtpEnabled: config.emailOtpEnabled,
    fixedTestOtpEnabled: config.fixedTestOtpEnabled,
    allowedReturnToOrigins: await allowedReturnToOrigins(),
  });
  if (!resolved.ok) {
    return c.text(resolved.message, resolved.status);
  }

  // The real sign-in, server-side: send-verification-otp stores the fixed
  // code (generateOTP in email-otp-plugin.ts) without emailing anything, and
  // sign-in/email-otp consumes it — creating the user through the normal
  // sign-up path (signup allowlist, avatar, admin promotion) when new.
  await auth.api.sendVerificationOTP({
    headers: c.req.raw.headers,
    body: { email: resolved.email, type: "sign-in" },
  });
  const signIn = await auth.api.signInEmailOTP({
    returnHeaders: true,
    headers: c.req.raw.headers,
    body: { email: resolved.email, otp: TEST_OTP_CODE },
  });

  await ensureOrganizationWithProject({
    userId: signIn.response.user.id,
    projectSlug: resolved.projectSlug,
  });

  const response = c.redirect(resolved.returnTo);
  appendSetCookieHeaders(response.headers, signIn.headers);
  return response;
}

/** return_to may leave this origin only toward a seeded relying party — the
 * deployment's Doppler-seeded OAuth clients (os, semaphore, ...) name their
 * origins via redirect URIs, so those rows are the allowlist. Seeded means
 * `referenceId IS NOT NULL`: only the service-token seeding lane sets it, so
 * dynamically-registered clients (open registration) can never allowlist an
 * attacker origin. */
async function allowedReturnToOrigins() {
  const origins = new Set<string>([config.authAppOrigin]);
  if (config.publicUrl) {
    origins.add(config.publicUrl);
  }
  for (const client of await listSeededOAuthClientRedirectUris(db)) {
    for (const redirectUri of parseStringArray(client.redirectUrisJson)) {
      if (URL.canParse(redirectUri)) {
        origins.add(new URL(redirectUri).origin);
      }
    }
  }
  return [...origins];
}

// A signed-in user with zero organizations parks on /project-access onboarding
// (auth-plugins.ts postLogin.shouldRedirect) instead of completing the OAuth
// flow, so make sure there is something to land in. Idempotent: users who
// already have an org (and any project) are left untouched, so repeat visits
// never create duplicates. Mirrors internal.organization.createForUser plus
// the project-access first-run form.
async function ensureOrganizationWithProject(input: { userId: string; projectSlug: string }) {
  const organizations = await listOrganizationsForUser(db, { userId: input.userId });
  let organizationId = organizations[0]?.id;
  if (!organizationId) {
    // The project slug names the org too, same reasoning as project-access:
    // every test signup shares the nustom.com domain, so a domain-derived
    // name would collide with the previous test user's organization.
    const slug = await resolveUniqueSlug({
      name: input.projectSlug,
      isTaken: async (candidate) => Boolean(await getOrganizationBySlug(db, { slug: candidate })),
    });
    organizationId = generateId("org");
    const now = Date.now();
    await db.transaction(async (tx) => {
      await insertOrganization(tx, {
        id: organizationId!,
        name: input.projectSlug,
        slug,
        createdAt: now,
        metadata: null,
        logo: null,
      });
      await insertMembership(tx, {
        id: generateId("member"),
        organizationId: organizationId!,
        userId: input.userId,
        role: "owner",
        createdAt: now,
      });
    });
  }

  const projects = await listProjectsForUser(db, { userId: input.userId });
  if (projects.length > 0) {
    return;
  }
  // Project slugs are globally unique; when another org owns the requested
  // slug, take a suffixed one rather than failing the login.
  const projectSlug = await resolveUniqueSlug({
    name: input.projectSlug,
    isTaken: async (candidate) => {
      const existing = await getProjectWithOrganizationBySlug(db, { slug: candidate });
      return Boolean(existing && existing.organizationId !== organizationId);
    },
  });
  const result = await createProject(db, {
    name: projectSlug,
    organizationId,
    slug: projectSlug,
  });
  if (!result.ok) {
    throw new Error(`test-login could not create project "${projectSlug}": ${result.message}`);
  }
}
