import { test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";
import type {
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { waitForPreviewRolloutBeforeProjectCreation } from "@iterate-com/shared/test-support/preview-rollout-gate";
import {
  connectItxReady,
  type ItxInitialConnectionRetry,
  type ProjectAiInterceptor,
  type ProjectAiInterceptorInput,
} from "iterate/node";
import { doppler } from "../../apps/os/scripts/dev.ts";
import { mintForgedAccessToken, mintForgedIdToken } from "../../scripts/auth/forge-token.ts";
// Lazy circular import (function-call-time only): the helper dials its
// dedicated session through connectAdminItx below.
import { installResilientAiInterceptor } from "./resilient-ai-interceptor.ts";

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
  /** Private half of the ES256 Auth signing key whose public half OS trusts. */
  AUTH_FORGE_ES256_PRIVATE_JWK: z
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
const ITX_INITIAL_CONNECTION_RETRY_PREFIX = "[itx-initial-connection-retry] ";

export async function createProjectFixture(
  slugPrefix: string,
  input: {
    baseURL: string | undefined;
    page: Page;
    projectCount?: number;
    testInfo: TestInfo;
  },
) {
  const baseUrl = input.baseURL;
  if (!baseUrl) throw new Error("Playwright baseURL fixture is required.");

  const [config] = await Promise.all([
    resolveOsPlaywrightAuthConfig(),
    waitForPreviewRolloutBeforeProjectCreation({
      beforeWait: (waitMs) => input.testInfo.setTimeout(input.testInfo.timeout + waitMs),
    }),
  ]);
  const projectSlug = uniqueFixtureSlug(slugPrefix);
  const projectFixtures = await Promise.all(
    Array.from({ length: input.projectCount ?? 1 }, (_, index) =>
      createAdminProjectAfterPreviewRollout({
        baseUrl,
        config,
        slug: index === 0 ? projectSlug : uniqueFixtureSlug(`${slugPrefix}-${index + 1}`),
      }),
    ),
  );
  try {
    const organization = {
      id: `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      name: `Playwright ${projectSlug}`,
      role: "admin" as const,
      slug: uniqueFixtureSlug(`${slugPrefix}-org`),
    };
    const session = await mintIterateSession({
      baseUrl,
      email: `forged-${projectSlug}+test@nustom.com`,
      organizations: [organization],
      projects: projectFixtures.map(({ project }) => ({
        ...project,
        organizationId: organization.id,
      })),
    });

    await input.page.context().addCookies([
      {
        expires: Math.floor(session.expiresAtMs / 1000),
        httpOnly: true,
        name: "iterate_session",
        sameSite: "Lax",
        secure: new URL(baseUrl).protocol === "https:",
        url: baseUrl,
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

    const project = projectFixtures[0]!.project;
    // Sync RPC stubs (admin / project / agents) live on this stack; the
    // fixture's asyncDispose drains it so specs need only `await using fixture`.
    const resources = new AsyncDisposableStack();
    let admin: Awaited<ReturnType<typeof connectAdminItx>> | undefined;
    let itxHandle:
      | ReturnType<Awaited<ReturnType<typeof connectAdminItx>>["projects"]["get"]>
      | undefined;

    const connectAdmin = async () => {
      if (admin) return admin;
      admin = resources.use(await connectAdminItx(baseUrl));
      return admin;
    };

    /** Project-scoped itx (admin dial → `projects.get`). Cached on the fixture. */
    const itx = async () => {
      if (itxHandle) return itxHandle;
      const adminSession = await connectAdmin();
      itxHandle = resources.use(adminSession.projects.get(project.id));
      return itxHandle;
    };

    const interceptAi = (handler: ProjectAiInterceptor) =>
      installResilientAiInterceptor({
        baseUrl,
        projectId: project.id,
        handler,
      });

    const agentTurnInterceptors: Map<string, ProjectAiInterceptor> = new Map();
    const addAgentTurnInterceptor = async (agentPath: string, handler: ProjectAiInterceptor) => {
      if (agentTurnInterceptors.size === 0) {
        const handler: ProjectAiInterceptor = async (call) => {
          if (call.source !== "agent-turn") {
            throw new Error(
              `unexpected source: ${call.source}, you will need to register a custom ai interceptor for agent turns`,
            );
          }
          const interceptor = agentTurnInterceptors.get(call.agentPath);
          if (!interceptor) {
            throw new Error(`no interceptor registered for agent path: ${call.agentPath}`);
          }
          return await interceptor(call);
        };
        resources.use(await interceptAi(handler));
      }
      agentTurnInterceptors.set(agentPath, handler);
    };

    const createAgent = async (params?: { infix?: string; useRealLlm?: boolean }) => {
      const slugParts = [slugPrefix, params?.infix, crypto.randomUUID().slice(0, 8)];
      const path = `/agents/${slugParts.filter(Boolean).join("-")}`;
      const projectRpc = await itx();
      const agent = resources.use(projectRpc.agents.get(path));
      class ResponseQueuer {
        responders: Array<{
          times: number;
          fn: (
            call: Extract<ProjectAiInterceptorInput, { source: "agent-turn" }>,
          ) => Promise<string>;
        }> = [];

        /** fingerprint -> script, so retries get the same script as last time */
        previous: Map<string, (typeof this)["responders"][number]["fn"]> = new Map();

        set(script: Parameters<typeof this.setTimes>[1]) {
          this.setTimes(Infinity, script);
        }

        setOnce(script: Parameters<typeof this.setTimes>[1]) {
          this.setTimes(1, script);
        }

        setTimes(times: number, script: string | (typeof this)["responders"][number]["fn"]) {
          const fn =
            typeof script === "function"
              ? script
              : async () => `\`\`\`ts\n${script.toString()}\n\`\`\``;
          this.responders.push({ times, fn });
        }

        take(call: ProjectAiInterceptorInput) {
          const fingerprint = JSON.stringify(call);
          const existing = this.previous.get(fingerprint);
          if (existing) return existing;

          const next = this.responders[0];
          if (!next) return undefined;
          if (--next.times === 0) this.responders.shift();
          this.previous.set(fingerprint, next.fn);
          return next.fn;
        }
      }
      const responses = new ResponseQueuer();
      await agent.create();
      if (!params?.useRealLlm) {
        await agent.append({
          type: "events.iterate.com/agent/configured",
          payload: { config: { llm: { model: "intercepted/typed" }, llmRequestDebounceMs: 250 } },
        });
        await addAgentTurnInterceptor(path, async (call) => {
          const next = responses.take(call);
          if (!next) throw new Error(`No responses available for agent ${path}`);
          return await next(call as Extract<ProjectAiInterceptorInput, { source: "agent-turn" }>);
        });
      }
      const webUrl = `/projects/${project.slug}/agents/streams${path}`;
      // Cap'n Web stubs reject arbitrary property writes — proxy path/webUrl on.
      // `then: never` stops `await createAgent()` unwrapping through the stub's
      // Promise intersection and stripping path/webUrl from the type.
      const extras = { path, webUrl, responses, then: null as never };
      return new Proxy(agent as typeof agent & typeof extras, {
        get(target, prop, receiver) {
          if (prop in extras) return extras[prop as keyof typeof extras];
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          return prop in extras || Reflect.has(target, prop);
        },
      });
    };

    return {
      organization,
      project,
      projects: projectFixtures.map(({ project: p }) => p),
      session,
      /**
       * Admin itx for the fixture's deployment. Cached and disposed with the
       * fixture — no `using` at the call site.
       */
      connectAdmin,
      /**
       * Project-scoped itx for the fixture's first project — the handle mobile
       * specs currently dial with `connectItxReady({ projectId })`. Opens (and
       * caches) admin as needed; disposed with the fixture.
       */
      itx,
      /**
       * Create an agent on the fixture project. Optional path defaults to
       * `/agents/<slugPrefix>-<random>`; the returned handle carries `.path`
       * and `.webUrl` for `page.goto`. Disposed with the fixture.
       */
      createAgent,
      /** Churn-surviving `intercepted/*` handler for the fixture's first
       * project — `installResilientAiInterceptor` on a dedicated connection.
       * Dispose with `await using`. Guide: docs/intercepted-models.md. */
      interceptAi,
      async [Symbol.asyncDispose]() {
        await resources.disposeAsync();
        await Promise.all(projectFixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
      },
    };
  } catch (error) {
    await Promise.all(projectFixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
    throw error;
  }
}

/**
 * Admin itx handle for specs that drive a fixture project server-side (e.g.
 * append events and assert the browser repaints from the push). Dispose with
 * `using` — the handle owns its WebSocket. `onWebSocketClose` observes the
 * socket dying, however it dies — the hook a reconnect loop hangs off (see
 * resilient-ai-interceptor.ts).
 */
export async function connectAdminItx(
  baseUrl: string,
  options?: { onWebSocketClose?: (close: { code: number; reason: string }) => void },
) {
  const config = await resolveOsPlaywrightAuthConfig();
  return connectPlaywrightAdminItx({ baseUrl, config, ...options });
}

/** The OS admin API secret, for specs that dial project-scoped itx handles directly. */
export async function resolveAdminSecret(): Promise<string> {
  return (await resolveOsPlaywrightAuthConfig()).adminApiSecret;
}

async function createAdminProjectAfterPreviewRollout(input: {
  baseUrl: string;
  config: OsPlaywrightAuthConfig;
  slug: string;
}) {
  // create() resolves only after the bootstrap saga commits terminal
  // project/created (sibling processors born, config repo seeded, the seed
  // worker reachable, and its permanent feed installed), so no separate
  // lifecycle poll is needed. The shared helper retries the initial admin
  // connection while a preview deployment finishes converging.
  using session = await connectPlaywrightAdminItx(input);
  using created = await session.projects.get(input.slug).create({});
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

async function connectPlaywrightAdminItx(input: {
  baseUrl: string;
  config: OsPlaywrightAuthConfig;
  onWebSocketClose?: (close: { code: number; reason: string }) => void;
}) {
  return test.step("connect admin itx", () =>
    connectItxReady(
      {
        auth: { type: "admin-secret", secret: input.config.adminApiSecret },
        baseUrl: input.baseUrl,
        headers: cloudflareWorkerVersionOverrideHeaders(process.env),
        ...(input.onWebSocketClose === undefined
          ? {}
          : { onWebSocketClose: input.onWebSocketClose }),
      },
      {
        retryInitialConnection: {
          delayMs: 250,
          onRetry: recordInitialConnectionRetry,
        },
      },
    ));
}

async function recordInitialConnectionRetry(retry: ItxInitialConnectionRetry) {
  const code =
    "code" in retry.error && typeof retry.error.code === "string" ? retry.error.code : undefined;
  const diagnostic = JSON.stringify({
    attemptDurationMs: Math.round(retry.attemptDurationMs),
    delayMs: retry.delayMs,
    error: retry.error.message,
    ...(code === undefined ? {} : { errorCode: code }),
    failedAttempt: retry.failedAttempt,
    nextAttempt: retry.nextAttempt,
    startedAt: retry.startedAt,
  });

  await test.step("itx: initial connection retry", () => {
    test.info().annotations.push({
      type: "itx-initial-connection-retry",
      description: diagnostic,
    });
    process.stderr.write(`${ITX_INITIAL_CONNECTION_RETRY_PREFIX}${diagnostic}\n`);
  });
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
    forgePrivateJwk: env.AUTH_FORGE_ES256_PRIVATE_JWK,
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
