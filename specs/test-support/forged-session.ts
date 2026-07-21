import type { Page } from "@playwright/test";
import { z } from "zod/v4";
import type {
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { connectItx } from "iterate/node";
import { doppler } from "../../apps/os/scripts/dev.ts";
import { freshTestProjectId } from "../../apps/os/e2e/test-support/with-test-project-identifiers.ts";
import { mintForgedAccessToken, mintForgedIdToken } from "../../scripts/auth/forge-token.ts";

type OsPlaywrightAuthConfig = {
  adminApiSecret: string;
  clientId: string;
  /** The forge private JWK as its raw JSON string — what forge-token.ts consumes. */
  forgePrivateJwk: string;
  issuer: string;
};

type OsPlaywrightAuthEnv = z.infer<typeof OsPlaywrightAuthEnv>;

const OsPlaywrightAuthEnv = z.object({
  /** OS admin handle used to create and clean up fixture projects through /api/itx. */
  APP_CONFIG_ADMIN_API_SECRET: z.string().min(1),
  /** OAuth client id used as the id-token audience. */
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: z.string().min(1),
  /** Auth issuer used for both forged access and id tokens. */
  APP_CONFIG_ITERATE_AUTH__ISSUER: z.url(),
  /** Private half of the Auth signing key whose public half OS trusts. */
  AUTH_FORGE_PRIVATE_JWK: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, "must be the forge private JWK as a JSON string"),
});

export type MintedIterateSession = {
  accessToken: string;
  expiresAtMs: number;
  idToken: string;
};

let configPromise: Promise<OsPlaywrightAuthConfig> | undefined;

export async function createProjectFixture(
  slugPrefix: string,
  input: { baseURL: string | undefined; page: Page },
) {
  if (!input.baseURL) throw new Error("Playwright baseURL fixture is required.");

  const projectSlug = uniqueFixtureSlug(slugPrefix);
  const projectFixture = await createAdminProject({ baseUrl: input.baseURL, slug: projectSlug });
  try {
    const organization = {
      id: `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      name: `Playwright ${projectSlug}`,
      role: "admin" as const,
      slug: uniqueFixtureSlug(`${slugPrefix}-org`),
    };
    const session = await mintIterateSession({
      baseUrl: input.baseURL,
      email: `forged-${projectSlug}+test@nustom.com`,
      organizations: [organization],
      projects: [
        {
          id: projectFixture.project.id,
          organizationId: organization.id,
          slug: projectFixture.project.slug,
        },
      ],
    });

    await input.page.context().addCookies([
      {
        expires: Math.floor(session.expiresAtMs / 1000),
        httpOnly: true,
        name: "iterate_session",
        sameSite: "Lax",
        secure: new URL(input.baseURL).protocol === "https:",
        url: input.baseURL,
        value: encodeURIComponent(
          JSON.stringify({
            accessToken: session.accessToken,
            accessTokenExpiresAt: session.expiresAtMs,
            idToken: session.idToken,
            tokenType: "bearer",
          }),
        ),
      },
    ]);

    return {
      organization,
      project: projectFixture.project,
      session,
      async [Symbol.asyncDispose]() {
        await projectFixture[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await projectFixture[Symbol.asyncDispose]();
    throw error;
  }
}

/**
 * Admin itx handle for specs that drive a fixture project server-side (e.g.
 * append events and assert the browser repaints from the push). Dispose with
 * `using` — the handle owns its WebSocket.
 */
export async function connectAdminItx(baseUrl: string) {
  const config = await resolveOsPlaywrightAuthConfig();
  return connectItx({
    auth: { type: "admin-secret", secret: config.adminApiSecret },
    baseUrl,
  });
}

export async function createAdminProject(input: { baseUrl: string; slug: string }) {
  const config = await resolveOsPlaywrightAuthConfig();
  // itx-v4 cutover: this used to dial the legacy client (`withItx({baseUrl,
  // token})`) and then poll `project.processor.onStateChange` until the
  // project reached phase "ready". The itx create resolves only after the
  // bootstrap saga commits project/ready (sibling processors born, config repo
  // seeded, project worker probed), so the readiness wait is gone and auth is
  // an explicit admin-secret credential on connect.
  using session = connectItx({
    auth: { type: "admin-secret", secret: config.adminApiSecret },
    baseUrl: input.baseUrl,
  });
  using created = await session.projects
    .get(input.slug)
    .create({ projectId: freshTestProjectId() });
  const description = await created.__describe();
  const project = { id: description.projectId, slug: input.slug };

  return {
    project,
    [Symbol.asyncDispose]() {
      // itx-v4 cutover: this used to `projects.remove({id})`. TODO(task #13):
      // project removal on itx — disposable Playwright projects
      // are leaked until then (stages reset periodically).
      return Promise.resolve();
    },
  };
}

export async function mintIterateSession(input: {
  baseUrl: string;
  email: string;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
}): Promise<MintedIterateSession> {
  const config = await resolveOsPlaywrightAuthConfig();
  // Signing lives in scripts/auth/forge-token.ts (the core behind
  // `pnpm auth:mint`); this layer only picks the audience for the deployment
  // under test and wraps the token pair in a browser cookie.
  const accessToken = await mintForgedAccessToken({
    forgePrivateJwk: config.forgePrivateJwk,
    issuer: config.issuer,
    audience: authResourceForBaseUrl(input.baseUrl),
    email: input.email,
    organizations: input.organizations,
    projects: input.projects,
  });
  const idToken = await mintForgedIdToken({
    forgePrivateJwk: config.forgePrivateJwk,
    issuer: config.issuer,
    clientId: config.clientId,
    email: input.email,
  });

  // The cookie's expiry mirrors the access token's `exp` claim exactly —
  // the same derivation the session-from-token endpoint does server-side.
  const { exp } = JSON.parse(
    Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8"),
  ) as { exp: number };

  return {
    accessToken,
    expiresAtMs: exp * 1000,
    idToken,
  };
}

async function resolveOsPlaywrightAuthConfig(): Promise<OsPlaywrightAuthConfig> {
  configPromise = configPromise || loadOsPlaywrightAuthConfig();
  return await configPromise;
}

async function loadOsPlaywrightAuthConfig(): Promise<OsPlaywrightAuthConfig> {
  const env = await loadOsPlaywrightAuthEnv();

  return {
    adminApiSecret: env.APP_CONFIG_ADMIN_API_SECRET,
    clientId: env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID,
    forgePrivateJwk: env.AUTH_FORGE_PRIVATE_JWK,
    issuer: env.APP_CONFIG_ITERATE_AUTH__ISSUER,
  };
}

async function loadOsPlaywrightAuthEnv(): Promise<OsPlaywrightAuthEnv> {
  const env = OsPlaywrightAuthEnv.safeParse(process.env);
  if (env.success) return env.data;

  const dopplerEnv = doppler.loadOsSecrets();
  if (dopplerEnv.ok) {
    const parsed = OsPlaywrightAuthEnv.safeParse({ ...dopplerEnv.secrets, ...process.env });
    if (parsed.success) return parsed.data;

    throw new Error(
      [
        "Playwright forged-session specs require OS auth/admin env from Doppler.",
        "process.env was missing required values, and `doppler secrets download --no-file --format json` from apps/os did not contain valid replacements.",
        "process.env validation:",
        z.prettifyError(env.error),
        "apps/os Doppler validation:",
        z.prettifyError(parsed.error),
      ].join("\n\n"),
    );
  }

  throw new Error(
    [
      "Playwright forged-session specs require OS auth/admin env from Doppler.",
      "Run with `doppler run --project os --config <dev|preview_N> -- pnpm spec`, or configure Doppler for apps/os so `pnpm spec` can read secrets directly.",
      "process.env validation:",
      z.prettifyError(env.error),
      "apps/os Doppler lookup:",
      dopplerEnv.error,
    ].join("\n\n"),
  );
}

function authResourceForBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.endsWith(".localhost")
  ) {
    return `http://${url.hostname}`;
  }
  return baseUrl.replace(/\/+$/, "");
}
