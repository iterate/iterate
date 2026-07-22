import type { Page } from "@playwright/test";
import { z } from "zod/v4";
import type { RpcStub } from "capnweb";
import type {
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { connectItx } from "iterate/node";
import type { Session } from "../../apps/os/src/itx-api.generated.ts";
import { doppler } from "../../apps/os/scripts/dev.ts";
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

export type AdminItxSession = RpcStub<Session>;

type DuplicableAdminItxSession = AdminItxSession & {
  dup(): DuplicableAdminItxSession;
  [Symbol.dispose](): void;
};

/**
 * Own one authenticated admin transport per Playwright worker. Tests receive
 * duplicate capabilities with independent disposal; no application RPC is
 * replayed. A failed test invalidates the transport only for the next test.
 */
export class AdminItxSessionOwner {
  #root: DuplicableAdminItxSession | undefined;
  #baseUrl: string | undefined;

  constructor(
    private readonly connect: (baseUrl: string) => Promise<AdminItxSession>,
    private readonly log: Pick<Console, "info" | "warn"> = console,
  ) {}

  async acquire(baseUrl: string): Promise<AdminItxSession> {
    if (this.#baseUrl !== undefined && this.#baseUrl !== baseUrl) {
      throw new Error(
        `A Playwright worker cannot share one admin ITX session across ${this.#baseUrl} and ${baseUrl}.`,
      );
    }
    this.#baseUrl = baseUrl;
    if (this.#root === undefined) {
      this.log.info("[playwright-fixture] establishing worker admin ITX session");
      const root = (await this.connect(baseUrl)) as DuplicableAdminItxSession;
      try {
        // Force the WebSocket upgrade and authentication at this explicit test
        // boundary. Session metadata is cheap and has no domain side effects.
        await root.__describe();
      } catch (error) {
        root[Symbol.dispose]();
        throw error;
      }
      this.#root = root;
    }
    return this.#root.dup();
  }

  invalidate(reason: string): void {
    if (this.#root === undefined) return;
    this.log.warn(`[playwright-fixture] retiring worker admin ITX session: ${reason}`);
    const root = this.#root;
    this.#root = undefined;
    root[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    const root = this.#root;
    this.#root = undefined;
    root?.[Symbol.dispose]();
  }
}

let configPromise: Promise<OsPlaywrightAuthConfig> | undefined;

export async function createProjectFixture(
  slugPrefix: string,
  input: {
    adminItx: AdminItxSession;
    baseURL: string | undefined;
    page: Page;
    projectCount?: number;
    readiness?: "core" | "full";
    step?: <T>(name: string, body: () => Promise<T>) => Promise<T>;
  },
) {
  const baseUrl = input.baseURL;
  if (!baseUrl) throw new Error("Playwright baseURL fixture is required.");

  const projectSlug = uniqueFixtureSlug(slugPrefix);
  const step = input.step ?? (async (_name, body) => await body());
  const readiness = input.readiness ?? "full";
  const projectHandlePromises = Array.from({ length: input.projectCount ?? 1 }, (_, index) =>
    createAdminProject({
      session: input.adminItx,
      slug: index === 0 ? projectSlug : uniqueFixtureSlug(`${slugPrefix}-${index + 1}`),
      readiness,
    }),
  );
  let projectHandles: Array<Awaited<ReturnType<typeof createAdminProject>>>;
  try {
    projectHandles = await step(`fixture: wait for ${readiness} project readiness`, () =>
      Promise.all(projectHandlePromises),
    );
  } catch (error) {
    const settled = await Promise.allSettled(projectHandlePromises);
    await Promise.all(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value[Symbol.asyncDispose]()] : [],
      ),
    );
    throw error;
  }
  let projectFixtures: Array<{
    handle: Awaited<ReturnType<typeof createAdminProject>>;
    project: { id: string; slug: string };
  }>;
  try {
    projectFixtures = await step("fixture: read project identity", () =>
      Promise.all(
        projectHandles.map(async (created) => {
          const identity = await created.project.identity();
          return {
            handle: created,
            project: { id: identity.projectId, slug: identity.slug },
          };
        }),
      ),
    );
  } catch (error) {
    await Promise.all(projectHandles.map((handle) => handle[Symbol.asyncDispose]()));
    throw error;
  }
  return await createForgedBrowserFixture(
    slugPrefix,
    {
      baseURL: baseUrl,
      page: input.page,
      step,
    },
    projectFixtures.map(({ project }) => project),
    async () => {
      await Promise.all(projectFixtures.map(({ handle }) => handle[Symbol.asyncDispose]()));
    },
  );
}

export type ForgedFixtureProject = { id: string; slug: string };

/** Mint and install a fresh browser identity for already-created projects. */
export async function createForgedBrowserFixture(
  slugPrefix: string,
  input: {
    baseURL: string;
    page: Page;
    step?: <T>(name: string, body: () => Promise<T>) => Promise<T>;
  },
  projects: ForgedFixtureProject[],
  disposeProjects: () => Promise<void> = async () => {},
) {
  const project = projects[0];
  if (!project) {
    await disposeProjects();
    throw new Error("A forged browser fixture requires at least one project.");
  }
  const step = input.step ?? (async (_name, body) => await body());
  const organization = {
    id: `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: `Playwright ${project.slug}`,
    role: "admin" as const,
    slug: uniqueFixtureSlug(`${slugPrefix}-org`),
  };
  try {
    const session = await step("fixture: forge browser session", () =>
      mintIterateSession({
        baseUrl: input.baseURL,
        email: `forged-${project.slug}+test@nustom.com`,
        organizations: [organization],
        projects: projects.map((fixtureProject) => ({
          ...fixtureProject,
          organizationId: organization.id,
        })),
      }),
    );

    await step("fixture: install browser session cookie", () =>
      input.page.context().addCookies([
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
      ]),
    );

    return {
      organization,
      project,
      projects,
      session,
      [Symbol.asyncDispose]: disposeProjects,
    };
  } catch (error) {
    await disposeProjects();
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
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
}

export async function createAdminProject(input: {
  session: AdminItxSession;
  slug: string;
  readiness: "core" | "full";
}) {
  // The default full readiness contract resolves after project/ready (sibling
  // processors born, config repo seeded, project worker probed). The caller
  // owns the worker-scoped authenticated session and this returned project
  // capability is disposed with that test's duplicate.
  const project = await input.session.projects
    .get(input.slug)
    .create({}, { readiness: input.readiness });

  return {
    project,
    [Symbol.asyncDispose]() {
      // itx-v4 cutover: this used to `projects.remove({id})`. TODO(task #13):
      // project removal on itx — disposable Playwright projects
      // are leaked until then (stages reset periodically).
      project[Symbol.dispose]();
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
