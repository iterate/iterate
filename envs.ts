/** Deployment configuration for OS and its first-party apps. Secrets live in Doppler. */

import type { IngressRouting } from "./packages/iterate/src/project-ingress.ts";

/** Cloudflare account names, IDs, and shared credentials for account-wide tooling.
 * dev/preview shares one account; use its preview credentials, not a preview slot. */
const cloudflareAccounts = {
  prd: {
    cloudflareAccountId: "04b3b57291ef2626c6a8daa9d47065a7",
    dopplerProject: "_shared",
    dopplerConfig: "prd",
  },
  "dev/preview": {
    cloudflareAccountId: "376ef7ed81b0573f93524de763666c15",
    dopplerProject: "_shared",
    dopplerConfig: "preview",
  },
};

/** The production Cloudflare account (iterate.com zones). */
export const PRD_ACCOUNT_ID = cloudflareAccounts.prd.cloudflareAccountId;
/** The shared dev/preview Cloudflare account (iterate-preview-N and dev zones). */
export const PREVIEW_AND_DEV_ACCOUNT_ID = cloudflareAccounts["dev/preview"].cloudflareAccountId;

/**
 * Placeholder for a Cloudflare resource that hasn't been created yet.
 * Deploy scripts refuse to ship it; `ensure-resources` replaces it.
 */
export const UNPROVISIONED = "UNPROVISIONED";

/** The Doppler project holding apps/os's secrets (and apps/spa's deploy credentials): one config per
 *  `osEnvs` deployment, each inheriting `_shared/<config>`. Every script that deploys, provisions,
 *  previews, erases or seeds an OS deployment reads its secrets from here. */
export const OS_DOPPLER_PROJECT = "os";

/** The PostHog project every app reports to — "iterate (prd)" in PostHog EU. A project key is public:
 *  it ships in every page that loads posthog-js. Only prd entries carry it, so previews send nothing. */
const ITERATE_POSTHOG_PROJECT_KEY = "phc_2MGb9SEJABGj4sCx4grFIbzMR7NjbcUgP5YmhSXfcr7";

/** apps/kit — the browser device installer (README there): a TanStack Start app like notes, an
 *  ordinary OAuth client of the platform, on the k.iterate.com custom domain. It owns no stateful
 *  Cloudflare resources. */
export interface KitEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `kit`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  /** PostHog's project key (`ITERATE_POSTHOG_PROJECT_KEY`), as every Start app's. Unset ⇒ no PostHog. */
  posthogProjectKey?: string;
}

export const kitEnvs = {
  // KIT AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's kit is its own worker (`previewDeployment`). Every kit lists and
  // flashes the same GitHub releases as production (apps/kit/src/firmware/releases.ts).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "kit",
    baseUrl: "https://kit.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    // The production account's workers.dev subdomain is `iterate`, making
    // this worker available at kiterate.iterate.workers.dev as well.
    workerName: "kiterate",
    baseUrl: "https://k.iterate.com",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
  },
} satisfies Record<string, KitEnv>;

export interface OsEnv {
  cloudflareAccountId: string;
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  mcpBaseUrl: string;
  /** PostHog's project key (`ITERATE_POSTHOG_PROJECT_KEY`): the worker's `APP_CONFIG
   *  posthogProjectKey`, which the issuer's own pages start posthog-js with. Unset ⇒ no PostHog. */
  posthogProjectKey?: string;
  /** The dash's origin for this deployment (apps/dash) — where the platform's landing page `/` sends
   *  a person, the platform being headless. Unset ⇒ the page names no dash (a preview has none). */
  dashBaseUrl?: string;
  /** The platform admins (apps/os src/app-config.ts `admins`): exact email addresses, not secrets,
   *  so here rather than in Doppler; the generator hands them to the worker as `APP_CONFIG_ADMINS`. */
  admins?: string[];
  /** How projects are reached over HTTP (`APP_CONFIG urls.ingressRouting`): `subdomains` hangs
   *  `<routingSlug>--<project>.<hostname>` and the apex `<project>.<hostname>` under a wildcard route the
   *  generator adds on `hostname`'s zone (ensure-resources creates the wildcard DNS record); `paths`
   *  serves `<baseUrl>/projects/<project>/<routingSlug>/…` from the one origin. Unset ⇒ no ingress. */
  ingressRouting?: NonNullable<IngressRouting>;
  /** The Artifacts namespace the `ARTIFACTS` binding names, `<workerName>-…`; ensure-resources
   *  creates it. A namespace cannot be renamed, and no other Worker may bind it: erase-data refuses a
   *  shared store, and another Worker would read every project's repos. */
  artifactsNamespace: string;
  /** The prefix of the deployment's named Cloudflare resources (KV `<prefix>-oauth|-itx`, R2
   *  `<prefix>-files`, the control plane's D1 `<prefix>-db`). Today it is the worker name; it is its own field so a worker can be renamed
   *  without renaming the data it binds. `ensure-resources`, erase-data and the wrangler generator
   *  derive the names from this, never from the worker name. */
  resourceNamePrefix: string;
  /** An owned zone served as the named project's config-worker apex: the zone's apex and every
   *  first-level name under it, each with a route and a proxied DNS record (ensure-resources). More
   *  specific Worker routes on that zone continue to take precedence. */
  projectWildcard?: { hostname: string; project: string; excludedHostnames?: string[] };
  /** The zone this deployment serves projects' own hostnames on as a Cloudflare for SaaS provider
   *  (apps/os src/project/custom-hostnames.ts): its fallback origin `cname.<zone>` is the
   *  deployment's, reached through the one `*\/*` route the generator adds. The worker creates each
   *  custom hostname at runtime with `APP_CONFIG.cloudflareApiToken` (Doppler). `dcvDelegationUuid`
   *  is the zone's Delegated DCV id (`GET /zones/:id/dcv_delegation/uuid`), which the owner's
   *  `_acme-challenge` CNAME names. */
  cloudflareForSaas?: { zone: string; zoneId: string; dcvDelegationUuid: string };
  /** The one-click sign-in links (apps/os src/test-link.ts, `APP_CONFIG_LOGIN__TEST_LINK__…`), and
   *  the test domain's `admin@` as the one admin the admin app's specs sign in as. A per-commit
   *  deployment's only: app-config.ts refuses the links off a workers.dev origin besides. The PR
   *  body that carries them is public, so a link signs nobody in until its redeemer proves at
   *  `admins.issuer` that they are an address `admins.emails` names (src/test-link-admins.ts). */
  testLinks?: { admins: { issuer: string; emails: string[] } };
  resources: { oauthKvId: string; itxKvId: string; dbId: string };
}

/** A per-commit deployment's apps/os (`previewDeployment`): no resource ids, because its own deploy
 *  provisions its resources, named after its worker (scripts/deploy.ts). */
export type OsPreviewEnv = Omit<OsEnv, "resources">;
export const osEnvs: Record<string, OsEnv> = {
  // MAIN ON THE DEV/PREVIEW ACCOUNT: preview-parents.yml redeploys it in place from every push to
  // main, beside the apps' main-on-dev workers, which sign in against it; its data is erased
  // nightly (preview-sweep.yml). People use it by hand. No PR deployment depends on it: each is a
  // set of workers of its own (`previewDeployment`). workers.dev only.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "os",
    baseUrl: "https://os.iterate-dev-preview.workers.dev",
    mcpBaseUrl: "https://os.iterate-dev-preview.workers.dev/mcp",
    dashBaseUrl: "https://dash.iterate-dev-preview.workers.dev",
    // Projects as paths on the one origin (`/projects/<slug>/<routingSlug>/…`): workers.dev has no
    // wildcard subdomains.
    ingressRouting: { type: "paths" },
    // Not the worker's name: local dev's R2 bucket is `os-files` (wrangler.base.jsonc).
    artifactsNamespace: "os-parent-repos",
    resourceNamePrefix: "os-parent",
    resources: {
      oauthKvId: "cc1ea2c05a104790aa2716a87f304b3a",
      itxKvId: "a5b73c18d78f4cafaa4fa5e67d7daadc",
      dbId: "0189bd9e-baa4-48f5-b39c-f57b8829d864",
    },
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "os-prd",
    // THE HEADLESS PLATFORM: sign-in, consent, `/api`, the OAuth endpoints — two no-build pages and
    // the OAuth endpoints, nothing else a person looks at. `dash.iterate.com` is the dash (apps/dash): sessions,
    // projects and organizations — an ordinary OAuth client of this issuer, like every other app.
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    dashBaseUrl: "https://dash.iterate.com",
    admins: ["jonas@nustom.com", "misha@nustom.com"],
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    ingressRouting: { type: "subdomains", hostname: "iterate.app" },
    // iterate.com and its first-level names are the iterate project's site; other domains are the
    // projects' own custom hostnames (garple.com, lispwoso.com, templestein.com), on iterate.app
    projectWildcard: {
      hostname: "iterate.com",
      project: "iterate",
      // These first-party origins have their own routes and OAuth clients. A missing route must
      // never make their client IDs look like clients of the cheese-game project at consent.
      excludedHostnames: [
        "os.iterate.com",
        "mcp.iterate.com",
        "dash.iterate.com",
        "agents.iterate.com",
        "notes.iterate.com",
        "admin.iterate.com",
        "k.iterate.com",
        "voice.iterate.com",
        "install.iterate.com",
      ],
    },
    cloudflareForSaas: {
      zone: "iterate.app",
      zoneId: "4dcf5f055005471a00eb7f7befb29e54",
      dcvDelegationUuid: "248299803bb79c97",
    },
    // Not `os-prd-repos`: the legacy platform's namespace of that name (2026-05-18) is still bound
    // by its artifact viewer, cf-artifact-viewer-prd (artifacts.iterate.com).
    artifactsNamespace: "os-prd-project-repos",
    resourceNamePrefix: "os-prd",
    resources: {
      oauthKvId: "5d23b869bff94a32a8f8049edc7de122",
      itxKvId: "c8432f0a49c94ae3984040c4f503b8c2",
      dbId: "e97228d0-0a93-47c2-8075-8d6ede6e95df",
    },
  },
};
/** apps/dash — THE DASH: sessions and personal access tokens, projects and organizations — the
 *  fat first-party TanStack Start app (README there), an ordinary OAuth client of the headless
 *  platform at os.iterate.com, on a custom domain (dash.iterate.com). */
export const dashEnvs = {
  // DASH AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's dash is its own worker (`previewDeployment`).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "dash",
    baseUrl: "https://dash.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dash",
    baseUrl: "https://dash.iterate.com",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
  },
};

/** apps/agents — the agents page (README there); the notes app's shape, on a custom domain. */
export const agentsEnvs = {
  // AGENTS AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's agents is its own worker (`previewDeployment`).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "agents",
    baseUrl: "https://agents.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "agents",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://agents.iterate.com",
  },
};

export const notesEnvs = {
  // NOTES AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's notes is its own worker (`previewDeployment`).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "notes",
    baseUrl: "https://notes.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "notes",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://notes.iterate.com",
  },
};

/** apps/admin — the platform's admin app (README there); the notes app's shape, on a custom domain. */
export const adminEnvs = {
  // ADMIN AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's admin is its own worker (`previewDeployment`).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "admin",
    baseUrl: "https://admin.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "admin",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://admin.iterate.com",
  },
};

export const voiceEnvs = {
  // VOICE AT MAIN on the dev/preview account, signed in against osEnvs.preview and
  // redeployed in place with it (preview-parents.yml). A PR's voice is its own worker (`previewDeployment`).
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "voice",
    baseUrl: "https://voice.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "voice",
    posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY,
    // This exact Worker route takes precedence over the iterate project's *.iterate.com route.
    baseUrl: "https://voice.iterate.com",
  },
};

/** The account's workers.dev subdomain: every dev/preview worker is `<worker>.<this>`. */
const PREVIEW_WORKERS_DEV = "iterate-dev-preview.workers.dev";

/** The apps on top of apps/os that a per-commit deployment deploys beside it, by the name each
 *  looks the others up by (scripts/lib/start-app.ts `ITERATE_APP_ORIGINS`). */
export const PREVIEW_DEPLOYMENT_APPS = [
  "dash",
  "agents",
  "notes",
  "admin",
  "voice",
  "kit",
] as const;

/** `<prefix>-<sha7>`: a prefix of lowercase words (`pr3144`, `main`, `real-model`), at most 28
 *  characters, then the tested commit's first 7 hex digits. Every worker and resource name of the
 *  set stays under 63 characters (`<name>-agents`, `<name>-os-oauth-kv`). */
const PREVIEW_DEPLOYMENT_NAME = /^(?<prefix>[a-z0-9]+(?:-[a-z0-9]+)*)-(?<sha>[0-9a-f]{7})$/;

/** THE PER-COMMIT DEPLOYMENTS (apps/os/scripts/preview.ts): every PR run and every CI workflow that
 *  tests a deployment gets a fresh set of plain Workers on the dev/preview account for the commit
 *  it tests, apps/os and each app on top, named `<name>-<app>` for a `name` of `<prefix>-<sha7>`:
 *  `pr3144-a1b2c3d-os` at `https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev`,
 *  `pr3144-a1b2c3d-dash`, …. The name decides everything, so the build, the deploy, the suites and
 *  the delete each derive the same set from it. apps/os's resources are named after its worker and
 *  provisioned by its first deploy: KV by wrangler (`<worker>-oauth-kv`, `<worker>-itx-kv`), the
 *  D1, R2 bucket and Artifacts namespace by scripts/deploy.ts. Nothing is redeployed in place: the
 *  next commit gets a set of its own, and the older one is deleted (preview.ts `cleanup-superseded`,
 *  preview-sweep.ts). Undefined for a name of any other shape. */
export function previewDeployment(name: string) {
  const match = PREVIEW_DEPLOYMENT_NAME.exec(name);
  if (!match?.groups || match.groups.prefix!.length > 28) return undefined;
  const origin = (app: string) => `https://${name}-${app}.${PREVIEW_WORKERS_DEV}`;
  const osWorker = `${name}-os`;
  const os: OsPreviewEnv = {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: osWorker,
    baseUrl: origin("os"),
    mcpBaseUrl: `${origin("os")}/mcp`,
    // named whether or not the run deploys the dash (a soak deploys apps/os alone)
    dashBaseUrl: origin("dash"),
    ingressRouting: { type: "paths" },
    testLinks: { admins: { issuer: osEnvs.prd!.baseUrl, emails: ["*@nustom.com"] } },
    artifactsNamespace: `${osWorker}-repos`,
    resourceNamePrefix: osWorker,
  };
  const apps = Object.fromEntries(
    PREVIEW_DEPLOYMENT_APPS.map((app) => [
      app,
      {
        cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
        dopplerConfig: "preview",
        workerName: `${name}-${app}`,
        baseUrl: origin(app),
      },
    ]),
  );
  return { name, prefix: match.groups.prefix!, sha: match.groups.sha!, os, apps };
}

/** Static OAuth example and downloadable unpacked Chrome extension. Credentials share the platform's Doppler project. */
export const spaEnvs = {
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "iterate-spa-preview",
    baseUrl: "https://iterate-spa-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "iterate-spa",
    baseUrl: "https://iterate-spa.iterate.workers.dev",
  },
};

/** apps/dummy-petshop — the fake third party apps/os's tests connect to over the real network (a
 *  plain Worker, no Start). Production only: its workers.dev origin, no routes, no DNS. */
export interface DummyPetshopEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `dummy-petshop`) supplying deploy credentials. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
}

export const dummyPetshopEnvs: Record<string, DummyPetshopEnv> = {
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dummy-petshop",
    baseUrl: "https://dummy-petshop.iterate.workers.dev",
  },
};

/** apps/ci-reports — the viewer for CI traces and Playwright HTML reports (docs/ci-traces.md): a plain
 *  Worker serving public Depot artifacts. CI tooling, so it lives on the dev/preview account with CI's
 *  Doppler config (_shared/preview supplies both the Cloudflare and the Depot token): its workers.dev
 *  origin, no routes, no DNS. The env is named for its use, not its Doppler config: deploy with
 *  `--env ci`. */
export const ciReportsEnvs: Record<
  string,
  { cloudflareAccountId: string; dopplerConfig: string; workerName: string; baseUrl: string }
> = {
  ci: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "ci-reports",
    baseUrl: "https://ci-reports.iterate-dev-preview.workers.dev",
  },
};

/** The CI bucket, `iterate-ci` (docs/test-evidence.md#one-bucket): each CI job attempt's test
 *  evidence folder under `evidence/`, the per-test tables' copies under `tables/`, and later the
 *  alert guards' state under `state/`. CI tooling, so it lives on the dev/preview account; CI
 *  writes it with the Cloudflare API token it already holds (Doppler `_shared/preview`'s
 *  CLOUDFLARE_API_TOKEN, used as S3 keys by `scripts/ci/test-evidence.ts upload`). Created by hand
 *  with that token, with lifecycle rules on `evidence/` only: docs/test-evidence.md#setup. */
export const ciBucketEnvs = {
  ci: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    bucketName: "iterate-ci",
  },
};
