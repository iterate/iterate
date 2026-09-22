/** Deployment configuration for os-next and its first-party apps. Secrets live in Doppler. */

import type { IngressRouting } from "./packages/iterate/src/next/project-ingress.ts";

/** Cloudflare account names, IDs, and shared credentials for account-wide tooling.
 * dev/preview shares one account; use its preview credentials, not a preview slot. */
export const cloudflareAccounts = {
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

export interface OsNextEnv {
  cloudflareAccountId: string;
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  mcpBaseUrl: string;
  /** The dash's origin for this deployment (apps/dash) — where the platform's landing page `/` sends
   *  a person, the platform being headless. Unset ⇒ the page names no dash (a preview has none). */
  dashBaseUrl?: string;
  /** How projects are reached over HTTP (`APP_CONFIG urls.ingressRouting`): `subdomains` hangs
   *  `<app>--<project>.<hostname>` and the apex `<project>.<hostname>` under a wildcard route the
   *  generator adds on `hostname`'s zone (ensure-resources creates the wildcard DNS record); `paths`
   *  serves `<baseUrl>/projects/<project>/<app>/…` from the one origin. Unset ⇒ no ingress. */
  ingressRouting?: NonNullable<IngressRouting>;
  artifactsNamespace: string;
  /** The name the Cloudflare resources were CREATED under (D1 `<prefix>-directory`, KV `<prefix>-oauth|-itx`) —
   *  pinned apart from `workerName` because the worker was renamed after they existed; `ensure-resources` and
   *  the wrangler generator derive names from this, never from the worker name. */
  resourceNamePrefix: string;
  /** TEMPORARY (`APP_CONFIG urls.temporaryCustomHostnames`) — hostnames of this deployment's own that
   *  ARE a project's apex: `{ "iterate2.com": "iterate" }` lands a request on that project's config
   *  worker `fetch`, exactly as `<project>.<hostname>` does. The generator adds one zone route per
   *  hostname (its registrable domain's zone must exist in the account), ensure-resources the proxied
   *  DNS record. Belongs in the project's own runtime config, not here. */
  temporaryCustomHostnames?: Record<string, string>;
  /** The project-host zones this deployment serves as a Cloudflare for SaaS provider (the zone's
   *  fallback origin, `cname.<zone>`, is the deployment's).
   *  A `temporaryCustomHostnames` key whose zone lives in ANOTHER Cloudflare account is a CUSTOM
   *  HOSTNAME on the first of these (ensure-resources creates it; the owner CNAMEs their apex to the
   *  fallback origin), reached through the one `*\/*` route the generator adds per SaaS zone. */
  cloudflareForSaasProjectHostnameBases?: string[];
  resources: { directoryDbId: string; oauthKvId: string; itxKvId: string };
}
export const osNextEnvs: Record<string, OsNextEnv> = {
  // THE PARENT OF EVERY PER-PR PREVIEW (apps/os-next/scripts/preview.ts, the cloudflare-os recipe): a
  // Worker Preview is a branch of an existing worker, and this is that worker on the dev/preview
  // account — `pr<n>-<branch>-os-next-preview.<subdomain>.workers.dev`. Each preview has resources of
  // its own; nothing reads this worker's data, and nobody browses to it. workers.dev only.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "os-next-preview",
    baseUrl: "https://os-next-preview.iterate-dev-preview.workers.dev",
    mcpBaseUrl: "https://os-next-preview.iterate-dev-preview.workers.dev/mcp",
    // Projects as paths on the one origin (`/projects/<slug>/<app>/…`): workers.dev has no wildcard
    // subdomains, and every preview inherits this.
    ingressRouting: { type: "paths" },
    artifactsNamespace: "os-next-preview-repos",
    resourceNamePrefix: "os-next-preview",
    resources: {
      directoryDbId: "3c78dee6-80e5-49ed-a157-003278405ad0",
      oauthKvId: "f032a76654144557b48de0f86563a1db",
      itxKvId: "82406b38cf9949048097dde599a0087c",
    },
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "os-next-prd",
    // THE HEADLESS PLATFORM: sign-in, consent, `/api`, the OAuth endpoints — two no-build pages and
    // the OAuth endpoints, nothing else a person looks at. `dash.iterate2.com` is the dash (apps/dash): sessions,
    // projects and organizations — an ordinary OAuth client of this issuer, like every other app.
    baseUrl: "https://os.iterate2.com",
    mcpBaseUrl: "https://mcp.iterate2.com",
    dashBaseUrl: "https://dash.iterate2.com",
    ingressRouting: { type: "subdomains", hostname: "iterate2.app" },
    // Each apex is its project's: the config worker's `fetch` serves it. Every zone must exist in
    // the prd account for the route to deploy; the DNS record appears on `ensure-resources --env prd`.
    temporaryCustomHostnames: {
      // iterate2.com is a zone of this account: its own route and DNS record
      "iterate2.com": "iterate",
      // these three zones live in OTHER Cloudflare accounts: Cloudflare for SaaS custom hostnames on
      // iterate2.app (below), each apex CNAMEd by its owner to cname.iterate2.app
      "garple.com": "garple",
      "lispwoso.com": "lispwoso",
      "templestein.com": "templestein",
    },
    cloudflareForSaasProjectHostnameBases: ["iterate2.app"],
    artifactsNamespace: "project-worker-prd-repos",
    resourceNamePrefix: "project-worker-prd",
    resources: {
      directoryDbId: "be6a3789-726a-4786-8b50-ef150c583b4e",
      oauthKvId: "a1a12d1cf1c342f8a389e5bf9dc5b760",
      itxKvId: "02d9483f71b84a9f9fae588f0ad9b3bd",
    },
  },
};
/** apps/dash — THE DASH: sessions and personal access tokens, projects and organizations — the
 *  fat first-party TanStack Start app (README there), an ordinary OAuth client of the headless
 *  platform at os.iterate2.com, on the one custom domain among the apps. */
export const dashEnvs = {
  // THE PARENT of dash's per-PR Worker Previews (apps/os-next/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's os-next preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "dash-preview",
    baseUrl: "https://dash-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "dash",
    baseUrl: "https://dash.iterate2.com",
  },
};

/** apps/agents — the agents page (README there); the notes app's shape: its own workers.dev origin. */
export const agentsEnvs = {
  // THE PARENT of agents's per-PR Worker Previews (apps/os-next/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's os-next preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "agents-preview",
    baseUrl: "https://agents-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "agents",
    baseUrl: "https://agents.iterate.workers.dev",
  },
};

export const notesEnvs = {
  // THE PARENT of notes's per-PR Worker Previews (apps/os-next/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's os-next preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "notes-preview",
    baseUrl: "https://notes-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "notes",
    // Its own workers.dev subdomain — NOT a custom domain (iterate2.com is the iterate project's
    // apex, osNextEnvs.prd.temporaryCustomHostnames). A workers.dev baseUrl adds no custom route (below).
    baseUrl: "https://notes.iterate.workers.dev",
  },
};

export const voiceEnvs = {
  // THE PARENT of voice's per-PR Worker Previews (apps/os-next/scripts/preview.ts): each preview is a
  // branch of this worker, bound to the same PR's os-next preview as its issuer. Nothing reads its data.
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "voice-preview",
    baseUrl: "https://voice-preview.iterate-dev-preview.workers.dev",
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "voice",
    // Its own workers.dev subdomain — NOT a custom domain (iterate2.com is the iterate project's
    // apex, osNextEnvs.prd.temporaryCustomHostnames). A workers.dev baseUrl adds no custom route (below).
    baseUrl: "https://voice.iterate.workers.dev",
  },
};

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
