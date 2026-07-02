import type { Page } from "@playwright/test";
import { z } from "zod/v4";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
  type IterateAuthAccessTokenOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { doppler } from "../../apps/os/scripts/dev.ts";
import { connectItx } from "../../apps/os/src/next/client.ts";

type ForgePrivateJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
};

type OsPlaywrightAuthConfig = {
  adminApiSecret: string;
  clientId: string;
  forgePrivateJwk: ForgePrivateJwk;
  issuer: string;
};

type OsPlaywrightAuthEnv = z.infer<typeof OsPlaywrightAuthEnv>;

const ForgePrivateJwkSchema = z
  .looseObject({
    crv: z.literal("Ed25519"),
    kid: z.string().min(1),
    kty: z.literal("OKP"),
  })
  .transform((value) => value as ForgePrivateJwk);

const OsPlaywrightAuthEnv = z.object({
  /** OS admin handle used to create and clean up fixture projects through /api/itx. */
  APP_CONFIG_ADMIN_API_SECRET: z.string().min(1),
  /** OAuth client id used as the id-token audience. */
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: z.string().min(1),
  /** Auth issuer used for both forged access and id tokens. */
  APP_CONFIG_ITERATE_AUTH__ISSUER: z.url(),
  /** Private half of the forge key baked into dev/preview OS JWKS. */
  AUTH_FORGE_PRIVATE_JWK: z
    .string()
    .min(1)
    .transform((value, context) => {
      try {
        return JSON.parse(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: `Invalid JSON ${value}: ${error}` });
        return z.NEVER;
      }
    })
    .pipe(ForgePrivateJwkSchema),
});

export type MintedIterateSession = {
  accessToken: string;
  expiresAtMs: number;
  idToken: string;
};

let configPromise: Promise<OsPlaywrightAuthConfig> | undefined;
let signingKeyPromise: Promise<CryptoKey> | undefined;

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

export async function createAdminProject(input: { baseUrl: string; slug: string }) {
  const config = await resolveOsPlaywrightAuthConfig();
  // itx-v4 cutover: this used to dial the legacy client (`withItx({baseUrl,
  // token})`) and then poll `project.processor.onStateChange` until the
  // project reached phase "ready". The next engine's create resolves only
  // after the bootstrap saga committed project/created (repo seeded, project
  // worker probed, onboarding agent born), so the readiness wait is gone and
  // auth is an explicit admin-secret credential on connect.
  using session = connectItx({
    auth: { type: "admin-secret", secret: config.adminApiSecret },
    baseUrl: input.baseUrl,
  });
  using created = session.projects.create({ slug: input.slug });
  const description = await created.describe();
  const project = { id: description.projectId, slug: input.slug };

  return {
    project,
    [Symbol.asyncDispose]() {
      // itx-v4 cutover: this used to `projects.remove({id})`. TODO(task #13):
      // project removal on the next engine — disposable Playwright projects
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
}) {
  const config = await resolveOsPlaywrightAuthConfig();
  const subject = `usr_forged_${input.email.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = 60 * 60;
  const expiresAtSeconds = now + ttlSeconds;
  const sessionId = `ses_forged_${crypto.randomUUID().slice(0, 8)}`;

  const accessToken = await signJwt({
    audience: authResourceForBaseUrl(input.baseUrl),
    issuer: config.issuer,
    payload: {
      email: input.email,
      scope: "openid profile email",
      scopes: ["openid", "profile", "email"],
      sid: sessionId,
      [ITERATE_IS_ADMIN_CLAIM]: false,
      [ITERATE_ROLE_CLAIM]: null,
      [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: input.organizations,
      [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: input.projects,
    },
    subject,
    now,
    expiresAtSeconds,
    privateJwk: config.forgePrivateJwk,
  });
  const idToken = await signJwt({
    audience: config.clientId,
    issuer: config.issuer,
    payload: {
      email: input.email,
      email_verified: true,
      name: input.email.split("@")[0] || input.email,
      [ITERATE_IS_ADMIN_CLAIM]: false,
      [ITERATE_ROLE_CLAIM]: null,
    },
    subject,
    now,
    expiresAtSeconds,
    privateJwk: config.forgePrivateJwk,
  });

  return {
    accessToken,
    expiresAtMs: expiresAtSeconds * 1000,
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

async function signJwt(input: {
  audience: string;
  expiresAtSeconds: number;
  issuer: string;
  now: number;
  payload: Record<string, unknown>;
  privateJwk: ForgePrivateJwk;
  subject: string;
}) {
  const header = base64UrlEncode(
    JSON.stringify({
      alg: "EdDSA",
      kid: input.privateJwk.kid,
      typ: "JWT",
    }),
  );
  const payload = base64UrlEncode(
    JSON.stringify({
      ...input.payload,
      aud: input.audience,
      exp: input.expiresAtSeconds,
      iat: input.now,
      iss: input.issuer,
      sub: input.subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    await signingKey(input.privateJwk),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function signingKey(privateJwk: ForgePrivateJwk) {
  signingKeyPromise =
    signingKeyPromise ||
    crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  return await signingKeyPromise;
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

function base64UrlEncode(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

function uniqueFixtureSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}
