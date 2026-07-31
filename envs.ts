/**
 * The complete map of deployed Iterate environments, for every app.
 *
 * This file is the single source of truth for what makes one deployed
 * environment different from another: hostnames, worker names, and Cloudflare
 * account. Everything here is non-secret and reviewed like any other code;
 * secrets live in Doppler (one config per env per app, named below).
 *
 * Each app has its own map (envs/os, authEnvs, semaphoreEnvs, kitEnvs,
 * tunnelsEnvs, streamsExampleEnvs, dummyPetshopEnvs, docsEnvs) because apps
 * deploy to different
 * subsets of environments — forcing them into one record would mean optional
 * fields that lie. Hostnames follow conventions (`previewSlot(n)` derives them).
 *
 * Consumers: app deploy/config/resource scripts, via
 * scripts/lib/env-context.ts. They take `--env <name>` and look the
 * environment up here. The generated
 * wrangler.jsonc files are gitignored — this file is the reviewed artifact.
 *
 * Alchemy creates each deployed environment's D1, KV, and R2 resources. Its
 * generated output supplies their identifiers to the generated Wrangler config.
 *
 * Local dev environments (`dev`, `dev_<you>`) are deliberately NOT listed:
 * they never deploy — `pnpm dev` runs each app's top-level wrangler config
 * defaults under your local Doppler context.
 */

/** The production Cloudflare account (iterate.com zones). */
export const PRD_ACCOUNT_ID = "04b3b57291ef2626c6a8daa9d47065a7";
/** The shared dev/preview Cloudflare account (iterate-preview-N and dev zones). */
export const PREVIEW_AND_DEV_ACCOUNT_ID = "376ef7ed81b0573f93524de763666c15";

/**
 * One deployed environment of the OS product. A single environment spans
 * apps — the os worker and the auth worker deploy into the same stage and
 * consume resources from the same Alchemy output manifest.
 */
export interface DeployedEnv {
  /**
   * Cloudflare account the env deploys into. Scripts fail loudly when the
   * Doppler-supplied CLOUDFLARE_ACCOUNT_ID disagrees — catching the classic
   * "right command, wrong doppler config" drift.
   */
  cloudflareAccountId: string;
  /** Doppler config (project `os`) supplying this env's secrets. */
  dopplerConfig: string;
  /** The os worker script name, e.g. `os-prd`. */
  osWorkerName: string;
  /** The auth worker script name, e.g. `auth-prd`. */
  authWorkerName: string;
  /** The semaphore worker script name, e.g. `semaphore-prd`. */
  semaphoreWorkerName: string;
  /** Dashboard origin, e.g. https://os.iterate.com */
  baseUrl: string;
  /** MCP host origin, e.g. https://mcp.iterate.com */
  mcpBaseUrl: string;
  /** Public event type docs origin, e.g. https://events.iterate.com */
  eventDocsBaseUrl: string;
  /** Auth app origin, e.g. https://auth.iterate.com */
  authBaseUrl: string;
  /** Semaphore app origin, e.g. https://semaphore.iterate.com */
  semaphoreBaseUrl: string;
  /**
   * Base domains for deployed project hosts (`<slug>.<base>`). Worker routes are
   * generated for the built-in project host patterns.
   */
  projectHostnameBases: string[];
  /**
   * Project hostname bases that are Cloudflare for SaaS enabled. These get the
   * provider-zone catch-all route required for custom hostnames using the worker
   * as origin. Keep this a subset of `projectHostnameBases`; preview zones have
   * no SSL-for-SaaS quota unless Cloudflare explicitly provisions it.
   */
  cloudflareForSaasProjectHostnameBases: string[];
  /**
   * Owned Cloudflare zones where OS serves project custom-domain traffic at the
   * apex and single-label subdomains (`apex/*`, `*.apex/*`). More-specific
   * routes on the same zone (`os.`, `auth.`, `mcp.`, …) stay with their workers
   * and win by specificity. Used for the prod website: `iterate.com` → the
   * `iterate` project worker (also requires `hostname:iterate.com` in
   * PROJECT_DIRECTORY KV).
   */
  ownedProjectCustomApexes: string[];
  /**
   * How agent LLM turns travel through the Cloudflare AI Gateway: `unified`
   * = partner models on Cloudflare's unified billing; `byok` = the gateway's
   * universal endpoint with our own OpenAI key (correct prompt-cache
   * pricing, and the only path where the gateway's response cache works).
   */
  cloudflareAiGatewayTransport: "unified" | "byok";
  /**
   * Opts the BYOK lane into the AI Gateway RESPONSE cache (whole-answer
   * replay for byte-identical normalized requests — see
   * cloudflareAiGatewayResponseCacheKey). Only for envs whose conversations
   * are synthetic: previews and dev, where e2e reruns should replay
   * yesterday's answers for free. Leave unset on prd — a real user must
   * never receive a cached agent reply.
   */
  cloudflareAiGatewayResponseCacheTtlSeconds?: number;
}

/** Everything about a preview slot follows from its number by convention. */
function previewSlot(n: number): DeployedEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    osWorkerName: `os-preview-${n}`,
    authWorkerName: `auth-preview-${n}`,
    semaphoreWorkerName: `semaphore-preview-${n}`,
    baseUrl: `https://os.iterate-preview-${n}.com`,
    mcpBaseUrl: `https://mcp.iterate-preview-${n}.com`,
    eventDocsBaseUrl: `https://events.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
    semaphoreBaseUrl: `https://semaphore.iterate-preview-${n}.com`,
    projectHostnameBases: [`iterate-preview-${n}.app`],
    cloudflareForSaasProjectHostnameBases: [],
    ownedProjectCustomApexes: [],
    cloudflareAiGatewayTransport: "byok",
    // 7 days: long enough that overnight marathons and PR-lifetime reruns
    // replay each other, short enough that stale answers age out on their own.
    cloudflareAiGatewayResponseCacheTtlSeconds: 7 * 24 * 60 * 60,
  };
}

export const envs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    osWorkerName: "os-prd",
    authWorkerName: "auth-prd",
    semaphoreWorkerName: "semaphore-prd",
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    eventDocsBaseUrl: "https://events.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
    semaphoreBaseUrl: "https://semaphore.iterate.com",
    projectHostnameBases: ["iterate.app"],
    cloudflareForSaasProjectHostnameBases: ["iterate.app"],
    ownedProjectCustomApexes: ["iterate.com"],
    // BYOK, like every other env: unified billing meters OpenAI-prompt-cached
    // tokens at the uncached price (~6x at our hit rate), and BYOK benchmarked
    // latency-neutral-or-better. NO response cache here — that knob stays
    // preview/dev-only; a real user must never receive a cached agent reply.
    cloudflareAiGatewayTransport: "byok",
  },
  preview_1: previewSlot(1),
  preview_2: previewSlot(2),
  preview_3: previewSlot(3),
  preview_4: previewSlot(4),
  preview_5: previewSlot(5),
  preview_6: previewSlot(6),
  preview_7: previewSlot(7),
  preview_8: previewSlot(8),
  preview_9: previewSlot(9),
  preview_10: previewSlot(10),
  preview_11: previewSlot(11),
  preview_12: previewSlot(12),
  preview_13: previewSlot(13),
  preview_14: previewSlot(14),
  preview_15: previewSlot(15),
  preview_16: previewSlot(16),
  preview_17: previewSlot(17),
  preview_18: previewSlot(18),
  preview_19: previewSlot(19),
} satisfies Record<string, DeployedEnv>;

/** A deployed environment name, e.g. "prd" or "preview_3". */
export type EnvName = keyof typeof envs;
export type PreviewEnvName = Extract<EnvName, `preview_${number}`>;

/** Preview environments, derived from the canonical deployed environment map. */
export const deployedPreviewEnvs = Object.values(envs).filter((env) =>
  env.dopplerConfig.startsWith("preview_"),
);

/** Extract the numeric slot from a canonical preview environment. */
export function previewEnvironmentSlotNumber(env: Pick<DeployedEnv, "dopplerConfig">) {
  const match = /^preview_(\d+)$/.exec(env.dopplerConfig);
  if (!match) {
    throw new Error(`Invalid preview Doppler config ${JSON.stringify(env.dopplerConfig)}.`);
  }
  return Number(match[1]);
}

/** Every preview slot compiled into deploy tooling and env-manager. */
export const previewEnvironmentSlotNumbers = deployedPreviewEnvs.map(previewEnvironmentSlotNumber);

/**
 * Slots 18 and 19 are destructive env-manager proving grounds. They are real
 * environments, but Semaphore must never lease them to a PR.
 */
export const envManagerOnlyPreviewEnvironmentSlotNumbers = [18, 19];
const envManagerOnlyPreviewSlots = new Set(envManagerOnlyPreviewEnvironmentSlotNumbers);

/** Preview slots Semaphore may lease to PRs. */
export const claimablePreviewEnvironmentSlotNumbers = previewEnvironmentSlotNumbers.filter(
  (slot) => !envManagerOnlyPreviewSlots.has(slot),
);

function mapDeployedPreviewEnvs<Value>(
  mapEnv: (env: (typeof deployedPreviewEnvs)[number]) => Value,
): Record<PreviewEnvName, Value> {
  // deployedPreviewEnvs is the canonical exhaustive PreviewEnvName inventory,
  // and each dopplerConfig is unique, so fromEntries preserves every key once.
  return Object.fromEntries(
    deployedPreviewEnvs.map((env) => [env.dopplerConfig, mapEnv(env)]),
  ) as Record<PreviewEnvName, Value>;
}

/**
 * apps/auth deploys everywhere os does, PLUS `dev_global`
 * (auth.iterate-dev.com) — the shared issuer every local dev environment
 * signs in through. The subset of fields auth's scripts need.
 */
export interface AuthDeployedEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `auth`) supplying this env's secrets. */
  dopplerConfig: string;
  authWorkerName: string;
  authBaseUrl: string;
  /** Enables fixed `+test@nustom.com` OTPs for test automation. */
  fixedTestOtpEnabled: boolean;
}

function authEnvFromDeployedEnv(
  env: DeployedEnv,
  options: { fixedTestOtpEnabled: boolean },
): AuthDeployedEnv {
  return {
    cloudflareAccountId: env.cloudflareAccountId,
    dopplerConfig: env.dopplerConfig,
    authWorkerName: env.authWorkerName,
    authBaseUrl: env.authBaseUrl,
    fixedTestOtpEnabled: options.fixedTestOtpEnabled,
  };
}

export const authEnvs = {
  prd: authEnvFromDeployedEnv(envs.prd, { fixedTestOtpEnabled: false }),
  ...mapDeployedPreviewEnvs((env) => authEnvFromDeployedEnv(env, { fixedTestOtpEnabled: true })),
  dev_global: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "dev_global",
    authWorkerName: "auth-dev-global",
    authBaseUrl: "https://auth.iterate-dev.com",
    fixedTestOtpEnabled: true,
  },
} satisfies Record<EnvName | "dev_global", AuthDeployedEnv>;

/**
 * apps/semaphore — the preview-slot lease coordinator. prd serves all real
 * leasing (its coordinator DO holds live lease state — deploy over it, never
 * erase it); preview slots deploy it too so semaphore PRs get previews.
 */
export interface SemaphoreEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `semaphore`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  /**
   * The env's apps/auth deployment. Semaphore is a relying party of the same
   * issuer as os: deploys derive its public signing key from Doppler, and
   * requests authenticate with iterate sessions or bearer access tokens.
   */
  authBaseUrl: string;
}

function semaphoreEnvFromDeployedEnv(env: DeployedEnv): SemaphoreEnv {
  return {
    cloudflareAccountId: env.cloudflareAccountId,
    dopplerConfig: env.dopplerConfig,
    workerName: env.semaphoreWorkerName,
    baseUrl: env.semaphoreBaseUrl,
    authBaseUrl: env.authBaseUrl,
  };
}

export const semaphoreEnvs = {
  prd: semaphoreEnvFromDeployedEnv(envs.prd),
  ...mapDeployedPreviewEnvs(semaphoreEnvFromDeployedEnv),
} satisfies Record<EnvName, SemaphoreEnv>;

/**
 * apps/env-manager — the singleton control plane for the preview fleet.
 *
 * It lives in the dev/preview account with the resources it manages. Cloudflare
 * Access protects its only public hostname and uses production Auth as its OIDC
 * identity provider.
 */
export const envManagerEnv = {
  cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
  dopplerConfig: "prd",
  workerName: "env-manager",
  baseUrl: "https://envs.iterate-dev.com",
  authBaseUrl: "https://auth.iterate.com",
  accessTeamDomain: "iterate-dev-preview.cloudflareaccess.com",
  cloudflareApiTokenSecrets: {
    preview: {
      storeId: "fb2ef5d0ecb641acb909d3dab1dddc01",
      secretName: "ENV_MANAGER_PREVIEW_CLOUDFLARE_API_TOKEN",
    },
    production: {
      storeId: "fb2ef5d0ecb641acb909d3dab1dddc01",
      secretName: "ENV_MANAGER_PRODUCTION_CLOUDFLARE_API_TOKEN",
    },
  },
};

/**
 * apps/kit — the browser device installer. Production only: it intentionally
 * has no preview fleet and owns no stateful Cloudflare resources.
 */
export interface KitEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `kit`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
}

export const kitEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    // The production account's workers.dev subdomain is `iterate`, making
    // this worker available at kiterate.iterate.workers.dev as well.
    workerName: "kiterate",
    baseUrl: "https://k.iterate.com",
  },
} satisfies Record<string, KitEnv>;

/**
 * apps/tunnels — the captun gateway. prd only; dev tunnels ride prd.
 * No per-env resources (one DO class, no D1/KV), so its checked-in
 * wrangler.jsonc is hand-written rather than generated.
 */
export interface TunnelsEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `tunnels`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  /** Gateway hostname; tunnels live at `<name>.<hostname>`. */
  hostname: string;
}

export const tunnelsEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "tunnels-prd",
    hostname: "tunnels.iterate.com",
  },
} satisfies Record<string, TunnelsEnv>;

/**
 * apps/streams-example-app — the streams browser UI. Served on a custom
 * domain (`streams.<env zone>`) like every other app, not workers.dev:
 * workers.dev routes on this account have a documented drift class (routes
 * dead at the edge while the API says healthy), and a websocket-first app
 * feels every edge wobble. The deploy ensures the DNS record (create-only);
 * no other resources.
 */
export interface StreamsExampleEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `streams-example-app`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  /** The env's public origin (`https://streams.<env zone>`). */
  baseUrl: string;
  /**
   * The env's apps/auth deployment. The playground is a relying party of the
   * same issuer as os: deploys derive its public signing key from Doppler, and
   * requests authenticate with iterate sessions or bearer access tokens.
   */
  authBaseUrl: string;
}

/**
 * apps/dummy-petshop — the fake third-party "Pet Shop" service that
 * integration e2e tests connect to (OAuth 2.0 provider, legacy login, pets
 * API, signed webhooks, test backdoor). S0 of
 * apps/os/docs/integrations-and-secrets-design.md §7. Deploys everywhere os
 * does so every environment's integration specs have a real third party to
 * talk to. No Cloudflare resources beyond DNS — state is one Durable Object.
 */
export interface DummyPetshopEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `dummy-petshop`) supplying this env's secrets. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
}

function dummyPetshopPreviewSlot(n: number): DummyPetshopEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `dummy-petshop-preview-${n}`,
    baseUrl: `https://dummy-petshop.iterate-preview-${n}.com`,
  };
}

export const dummyPetshopEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dummy-petshop-prd",
    baseUrl: "https://dummy-petshop.iterate.com",
  },
  ...mapDeployedPreviewEnvs((env) => dummyPetshopPreviewSlot(previewEnvironmentSlotNumber(env))),
} satisfies Record<EnvName, DummyPetshopEnv>;

function streamsExamplePreviewSlot(n: number): StreamsExampleEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `streams-example-app-preview-${n}`,
    baseUrl: `https://streams.iterate-preview-${n}.com`,
    authBaseUrl: `https://auth.iterate-preview-${n}.com`,
  };
}

export const streamsExampleEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "streams-example-app-prd",
    baseUrl: "https://streams.iterate.com",
    authBaseUrl: "https://auth.iterate.com",
  },
  ...mapDeployedPreviewEnvs((env) => streamsExamplePreviewSlot(previewEnvironmentSlotNumber(env))),
} satisfies Record<EnvName, StreamsExampleEnv>;

/**
 * apps/docs — the stateless workspace-document vessel. Project-facing
 * traffic arrives through each project's `docs--<slug>` config-worker proxy;
 * these workers.dev origins are the independently deployed upstreams.
 *
 * Docs owns no storage. All document content and annotations remain in the
 * OS workspace selected by the deep link.
 */
export interface DocsEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `docs`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  /** Direct vessel origin used by the project config-worker proxy. */
  baseUrl: string;
  /** OS deployment that owns the workspaces this vessel addresses. */
  osBaseUrl: string;
}

function docsPreviewSlot(n: number): DocsEnv {
  return {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: `preview_${n}`,
    workerName: `docs-preview-${n}`,
    baseUrl: `https://docs-preview-${n}.iterate-dev-preview.workers.dev`,
    osBaseUrl: `https://os.iterate-preview-${n}.com`,
  };
}

export const docsEnvs = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "docs",
    baseUrl: "https://docs.iterate.workers.dev",
    osBaseUrl: "https://os.iterate.com",
  },
  ...mapDeployedPreviewEnvs((env) => docsPreviewSlot(previewEnvironmentSlotNumber(env))),
} satisfies Record<EnvName, DocsEnv>;
