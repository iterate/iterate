/**
 * Generates apps/os/wrangler.jsonc (gitignored) from the root envs.ts.
 *
 * Nobody edits or commits the output: vite.config.ts regenerates it before
 * every dev/build, deploys therefore always see a fresh one, and
 * `pnpm gen:wrangler` refreshes it by hand for ad-hoc wrangler commands.
 *
 * The top-level config is local dev (no routes, containers off by default so
 * `pnpm dev` never needs Docker — opt in with OS_SANDBOX_CONTAINER_LOCAL_DEV);
 * each deployed environment gets an env block expanded
 * from its envs.ts entry. Wrangler env blocks do not inherit binding keys,
 * so the shared bindings are spelled out per env by this script — that
 * repetition is exactly why the file is generated instead of hand-written.
 *
 * Everything here is non-secret. Secret VALUES never appear: secrets ride
 * `wrangler deploy --secrets-file` (see deploy.ts), and `secrets.required`
 * below is just the list of names — which also makes the vite plugin load
 * exactly those keys from process.env under `doppler run -- vite dev`.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs, PREVIEW_AND_DEV_ACCOUNT_ID, type DeployedEnv } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SANDBOX_INSTANCE_TYPES,
  type SandboxInstanceType,
} from "../src/domains/sandboxes/instance-types.ts";
import { workerEventsQueueName } from "../src/queue-names.ts";

/**
 * Secrets every deployment MUST have (deploy.ts fails before uploading when
 * the env's Doppler config is missing one). Keep this to what the product
 * genuinely can't run without — the zod parseConfig preflight in deploy.ts
 * is the real arbiter of shape.
 */
export const REQUIRED_SECRETS = [
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  "APP_CONFIG_OPEN_AI_API_KEY",
  "SECRET_ENCRYPTION_KEY",
];

/**
 * Optional-in-schema secrets: shipped when the env's Doppler config carries
 * them, silently skipped otherwise (e.g. preview slots have no Slack bot).
 * Not in the env blocks' `secrets.required` — wrangler would fail deploys
 * over them — but listed in the top-level (local dev) block so the vite
 * plugin loads whichever ones your Doppler config has.
 */
export const OPTIONAL_SECRETS = [
  "APP_CONFIG_CLOUDFLARE__API_TOKEN",
  "APP_CONFIG_GEMINI_API_KEY",
  // Iterate-owned Exa/Parallel API keys (platform-secrets.ts registry
  // entries) — collectSecrets ships only names listed here, so a key absent
  // from this list never reaches a deployed worker even when Doppler has it.
  "APP_CONFIG_INTEGRATIONS__EXA",
  "APP_CONFIG_INTEGRATIONS__GITHUB",
  "APP_CONFIG_INTEGRATIONS__GOOGLE",
  "APP_CONFIG_INTEGRATIONS__PARALLEL",
  // The first-party dummy-petshop client credentials (integration proofs);
  // backs /secrets/platform/integrations/petshop. Optional — only preview/dev
  // envs running the petshop e2e carry it.
  "APP_CONFIG_INTEGRATIONS__PETSHOP",
  "APP_CONFIG_INTEGRATIONS__SLACK",
  "APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED",
  "APP_CONFIG_ITERATE_AUTH__RESOURCE",
  "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN",
  "APP_CONFIG_LOGS",
  "APP_CONFIG_POSTHOG",
  "APP_CONFIG_SLACK_BOT_TOKEN",
  "APP_CONFIG_X_AI_API_KEY",
  // R2 S3-API credentials the Sandbox SDK uses to presign workspace-backup
  // transfers (exact names the SDK reads). Optional: without them the
  // sandbox DO falls back to streaming archives through the BACKUP_BUCKET
  // binding (the SDK's localBucket mode — slower, but persistence still
  // works; also the only mode local dev supports).
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

/**
 * Env-shaping config that is NOT secret and already lives in envs.ts —
 * emitted as per-env `vars` so the worker's runtime hostnames can never
 * drift from the routes generated off the same entry. Local dev has no env
 * block, so the top-level `secrets.required` also lists these names and the
 * vite plugin loads them from the Doppler-provided process.env.
 */
export function envShapedVars(env: DeployedEnv) {
  return {
    APP_CONFIG_BASE_URL: env.baseUrl,
    APP_CONFIG_MCP__BASE_URL: env.mcpBaseUrl,
    APP_CONFIG_PROJECT_HOSTNAME_BASES: JSON.stringify(env.projectHostnameBases),
    APP_CONFIG_ITERATE_AUTH__ISSUER: `${env.authBaseUrl}/api/auth`,
    // Newborn-agent default model. Only the prd Cloudflare account can run
    // OpenAI partner models over env.AI (the preview/dev account gets
    // `2021: Invalid User Credentials`; verified live 2026-07-10, prd
    // answered in seconds on identical code) — so every non-prd env pins a
    // Workers-AI-native model and prd omits the var to use the platform
    // default (openai/gpt-5.5). Scout over kimi: Workers AI per-minute rate
    // caps are PER MODEL and kimi's is tiny (two concurrent e2e lanes
    // saturate it; 15-60s/turn when it answers at all), while scout ran a
    // full agent turn in 2.6s with clean codemode fences and a 131k context
    // that fits the ~34k-token agent prompt (llama-3.3's 24k does not) —
    // all measured live on preview-1, 2026-07-10. Delete this override —
    // and the config knob it feeds (config.ts defaultAgentModel) — when the
    // preview/dev account gains partner-model access.
    ...(env.cloudflareAccountId === envs.prd.cloudflareAccountId
      ? {}
      : { APP_CONFIG_DEFAULT_AGENT_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct" }),
  };
}

const ENV_SHAPED_KEYS = Object.keys(envShapedVars(envs.prd));

// One compatibility date for the os worker AND the builder sidecar — a bump
// that misses one would be silent drift. (Deliberately distinct from
// WORKER_COMPATIBILITY_DATE in worker-loader.ts: dynamic-worker compat is
// hashed into build keys and moves on its own schedule.)
//
// Policy: stay on the LATEST — keep this at the newest date the pinned workerd
// supports (its build date; a later date errors as "in the future" locally).
// Bump it alongside the workerd/miniflare catalog bump in pnpm-workspace.yaml,
// so we always run current compat behavior and never accumulate opt-in flags
// for things that became default. Only genuinely non-default flags go in
// compatibility_flags below.
export const COMPATIBILITY_DATE = "2026-07-01";

// The os worker (reader) and the builder (writer) must name the same
// miniflare namespace in local dev or cache reads never see builds.
const LOCAL_DEV_BUILD_CACHE_ID = "local-dev-worker-build-cache";

/** The builder sidecar's worker name, derived — never spelled out in envs.ts. */
function builderWorkerName(osWorkerName: string) {
  return `${osWorkerName}-builder`;
}

/**
 * SSH keys authorized to `wrangler containers ssh` into ANY sandbox instance.
 *
 * Cloudflare Containers SSH is account-authenticated (you need Wrangler write
 * access to the container) AND gated on the container class carrying your
 * public key here — so this list, applied to the one sandbox container class,
 * makes every sandbox instance reachable at once. It opens no public port
 * (SSH tunnels through Wrangler/the control plane). SSH keys are public and
 * reviewed like any other code; ed25519 only (the platform rejects other
 * types). See docs/cloudflare-sandboxes.md.
 *
 * Add a teammate: append `{ name, public_key }` with their ed25519 key
 * (`gh api users/<login>/keys`, or `~/.ssh/id_ed25519.pub`).
 */
const SANDBOX_SSH_AUTHORIZED_KEYS: { name: string; public_key: string }[] = [
  {
    name: "jonastemplestein",
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB5Jd9GS/iVC1nWpIwrM3lhecTuXhsz8NoV8QcyOIuzK",
  },
  {
    name: "jonas-sandbox-debug",
    public_key:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP+VckcAWnI0ZbBLsxmKWJtv7lbDwPWcjN37dR/VYlLq sandbox-debug",
  },
];

const DO_CLASSES = {
  AGENT: "AgentDurableObject",
  CAPABILITY_HOST: "CapabilityHostDurableObject",
  PROJECT: "ProjectDurableObject",
  REPO: "RepoDurableObject",
  SCHEDULER: "SchedulerDurableObject",
  SECRET: "SecretDurableObject",
  STREAM: "StreamDurableObject",
  WORKER: "StatefulWorkerDurableObject",
  WORKSPACE: "WorkspaceDurableObject",
  // One sandbox container class PER INSTANCE TYPE (Cloudflare fixes instance_type per
  // class) — bindings and class names come from the canonical table in
  // src/domains/sandboxes/instance-types.ts.
  ...Object.fromEntries(
    SANDBOX_INSTANCE_TYPES.map((instanceType) => [
      SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].binding,
      SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
    ]),
  ),
} as const;

// Durable Object lifecycle, DECLARATIVE (wrangler's `exports` field, GA in
// wrangler 4.107): every class the worker hosts gets a live entry, and the
// server reconciles the declared set against the live namespaces ON EVERY
// DEPLOY. There is no migration tag and no linear history — which is what
// lets a preview slot deploy cleanly from any branch, regardless of what the
// previous branch left on the worker (the old tag-diff model wedged slots
// with API 10074/10061 whenever branch histories diverged).
//
// Deleting a class = replace its live entry with a hand-written
// `state: "deleted"` tombstone. That destroys the class's Durable Objects,
// their storage and alarms on the next deploy of each env. Tombstones are
// idempotent (a stale one is an info, not an error) and can be removed once
// every deployed env reports "Safe to remove from `exports`". Forgetting one
// fails the deploy with the exact tombstone line to add.
const DO_EXPORTS = {
  // Live entries derive from DO_CLASSES: bound ⇔ hosted, one source of truth.
  ...Object.fromEntries(
    Object.values(DO_CLASSES).map((className) => [
      className,
      { type: "durable-object", storage: "sqlite" },
    ]),
  ),
  // Sandboxes became pets with one container class per instance type (#1747);
  // the old implicit-size class is retired (old sandboxes were ephemeral by
  // design and their R2 snapshots age out).
  CloudflareSandboxDurableObject: { type: "durable-object", state: "deleted" },
};

/**
 * Per-size concurrent-instance caps. Cloudflare validates
 * `max_instances × instance memory` against the account's concurrent-memory
 * quota AT DEPLOY TIME, summed across every container app — and the preview
 * account is shared by every preview slot — so preview caps are deliberately
 * small (a slot's sandbox fleet reserves ~75 GiB vs production's ~260 GiB).
 * Billing is while-running only (idle sandboxes are torn down and snapshotted),
 * so production headroom is cheap; raise a cap here if a real workload hits it
 * (exceeding one surfaces as HTTP 503 on sandbox start).
 */
const SANDBOX_MAX_INSTANCES: Record<SandboxInstanceType, { preview: number; production: number }> =
  {
    lite: { preview: 20, production: 50 },
    basic: { preview: 10, production: 30 },
    "standard-1": { preview: 5, production: 20 },
    "standard-2": { preview: 2, production: 10 },
    "standard-3": { preview: 2, production: 5 },
    "standard-4": { preview: 1, production: 3 },
  };

/** Binding config identical across local dev and every deployed env, apart from names/ids. */
function workerBindings(input: {
  workerName: string;
  accountId: string;
  kvId?: string;
  workerBuildCacheKvId?: string;
  /** Which SANDBOX_MAX_INSTANCES column to apply — deploy-time memory quota
   * is validated per account, and previews share one account. */
  sandboxCaps?: "preview" | "production";
}) {
  return {
    vars: {
      WORKER_SELF: input.workerName,
      ARTIFACTS_ACCOUNT_ID: input.accountId,
      ARTIFACTS_NAMESPACE: `${input.workerName}-repos`,
      // Sandbox workspace backup config — names the Sandbox SDK reads from
      // the env verbatim (BACKUP_BUCKET_NAME, CLOUDFLARE_R2_ACCOUNT_ID);
      // the R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY presigning secrets ride in
      // from Doppler (OPTIONAL_SECRETS).
      BACKUP_BUCKET_NAME: `${input.workerName}-sandboxes`,
      CLOUDFLARE_R2_ACCOUNT_ID: input.accountId,
      // Sandbox DO↔container control-plane transport. HTTP is still the SDK
      // default in 0.12.3 but is removed from SDK releases after 2026-07-09
      // (tunnels/code-interpreter already require RPC); RPC is the future
      // default, so opt in now. Independent of container egress interception.
      // See docs/cloudflare-sandboxes.md.
      SANDBOX_TRANSPORT: "rpc",
      // Container startup budget must cover the IMAGE PULL on a host that
      // hasn't cached it. The SDK defaults (instance-get 30s — schedule+start
      // INCLUDING the pull; port-ready 90s) both sat inside a cold pull back
      // when the image baked the monorepo (~3 GB), killing the control-plane
      // dial mid-startup (OPERATION_INTERRUPTED / transport_disposed on
      // utils.createSession — the dominant e2e flake of that era). The image
      // is the stock Cloudflare one now, but a generous ceiling costs nothing
      // when startup is fast and only extends patience when a host is cold —
      // 300s is the SDK's validation max; anything slower is a genuinely
      // stuck container and should fail.
      SANDBOX_INSTANCE_TIMEOUT_MS: "300000",
      SANDBOX_PORT_TIMEOUT_MS: "300000",
    },
    durable_objects: {
      bindings: Object.entries(DO_CLASSES).map(([name, class_name]) => ({ name, class_name })),
    },
    kv_namespaces: [
      {
        binding: "PROJECT_DIRECTORY",
        // Local dev has no real namespace; miniflare only needs a stable id.
        id: input.kvId ?? "local-dev-project-directory",
      },
      {
        binding: "WORKER_BUILD_CACHE",
        id: input.workerBuildCacheKvId ?? LOCAL_DEV_BUILD_CACHE_ID,
      },
    ],
    services: [
      // The builder sidecar (src/builder.ts, wrangler.builder.jsonc): the one
      // script carrying the dynamic-worker bundler toolchain (esbuild-wasm,
      // ~14MB) so the product script stays small. Bound by name — deploy.ts
      // deploys the builder first.
      { binding: "BUILDER", service: builderWorkerName(input.workerName) },
    ],
    ai: { binding: "AI" },
    browser: { binding: "BROWSER" },
    images: { binding: "IMAGES" },
    media: { binding: "MEDIA" },
    // Deploy identity for the stream processor hosts' crash-loop breaker: a
    // revival that sees a NEW version id starts from a fresh backoff budget
    // (the antidote deploy). Absent in local dev (miniflare fakes it or omits
    // it); workerVersion(env) tolerates undefined.
    version_metadata: { binding: "CF_VERSION_METADATA" },
    worker_loaders: [{ binding: "LOADER" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: `${input.workerName}-repos` }],
    queues: {
      consumers: [
        {
          queue: workerEventsQueueName(input.workerName),
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
          retry_delay: 30,
        },
      ],
    },
    // Sandbox workspace backups (ensure-resources.ts creates the bucket; the
    // sandbox DO snapshots /workspace here on idle and restores on start).
    // The binding MUST be named BACKUP_BUCKET — the Sandbox SDK reads it from
    // the env by that exact name. Addressed by name, so — unlike KV/D1 — no
    // per-env id in envs.ts. In local dev miniflare provides it automatically.
    // FILES_BUCKET: project file storage for itx.files / agent attachments
    // (domains/files/project-files.ts). Same create-if-missing story.
    r2_buckets: [
      { binding: "BACKUP_BUCKET", bucket_name: `${input.workerName}-sandboxes` },
      { binding: "FILES_BUCKET", bucket_name: `${input.workerName}-files` },
    ],
    // Email Service send binding for itx.email. Sender authorization is
    // enforced in OS (a project only sends as <slug>@<hostname base>, see
    // rpc-targets.ts EmailRpcTarget) — allowed_sender_addresses can't hold a
    // dynamic per-project set. Local dev gets the same binding; miniflare
    // simulates sends instead of delivering real mail.
    send_email: [{ name: "EMAIL" }],
    // One container app per sandbox size, all running the STOCK Cloudflare
    // sandbox image (sandbox/Dockerfile is a one-line FROM — no bake, so
    // builds and deploys are fast and every size shares one cached image).
    // `instance_type` is the size verbatim: our size names ARE Cloudflare's
    // instance-type names (instance-types.ts).
    containers: SANDBOX_INSTANCE_TYPES.map((instanceType) => ({
      class_name: SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
      image: "./sandbox/Dockerfile",
      instance_type: instanceType,
      max_instances: SANDBOX_MAX_INSTANCES[instanceType][input.sandboxCaps ?? "preview"],
      // Interactive shell into any running sandbox via `wrangler containers
      // ssh <instance-id>` (find ids with `wrangler containers instances`).
      // Account-authenticated + gated on the keys below; opens no public
      // port. See docs/cloudflare-sandboxes.md. `enabled` defaults false in
      // the wrangler schema, so it is set explicitly.
      ssh: { enabled: true },
      authorized_keys: SANDBOX_SSH_AUTHORIZED_KEYS,
    })),
    secrets: { required: REQUIRED_SECRETS },
    observability: OBSERVABILITY,
  };
}

/**
 * Every hostname routed to the os worker: the app base URL, public event docs,
 * the MCP host, project-host patterns, and any SaaS-enabled provider-zone
 * catch-all routes. The zone is the hostname minus its first label for
 * app/MCP/event-docs hosts; project bases are themselves zones.
 *
 * Project bases get three built-in project-host patterns: `base/*`,
 * `*.base/*`, and `*base/*`.
 * The `*base/*` pattern should subsume the first two, but the live preview zone
 * only reliably invoked the worker for project hosts once all three existed
 * (observed 2026-06) — kept verbatim; collapse only with an edge experiment
 * proving it.
 */
function routes(env: DeployedEnv) {
  const appHost = new URL(env.baseUrl).hostname;
  const mcpHost = new URL(env.mcpBaseUrl).hostname;
  const eventDocsHost = new URL(env.eventDocsBaseUrl).hostname;
  const zoneOf = (host: string) => host.split(".").slice(1).join(".");
  const cloudflareForSaasBases = new Set(env.cloudflareForSaasProjectHostnameBases);
  return [
    { pattern: `${appHost}/*`, zone_name: zoneOf(appHost) },
    { pattern: `${eventDocsHost}/*`, zone_name: zoneOf(eventDocsHost) },
    { pattern: `${mcpHost}/*`, zone_name: zoneOf(mcpHost) },
    ...env.projectHostnameBases.flatMap((base) => {
      const projectRoutes = [
        { pattern: `${base}/*`, zone_name: base },
        { pattern: `*.${base}/*`, zone_name: base },
        { pattern: `*${base}/*`, zone_name: base },
      ];
      return cloudflareForSaasBases.has(base)
        ? [{ pattern: "*/*", zone_name: base }, ...projectRoutes]
        : projectRoutes;
    }),
  ];
}

function envBlock(env: DeployedEnv) {
  const isProduction = env.osWorkerName === "os-prd";
  const bindings = workerBindings({
    workerName: env.osWorkerName,
    accountId: env.cloudflareAccountId,
    kvId: env.resources.projectDirectoryKvId,
    workerBuildCacheKvId: env.resources.workerBuildCacheKvId,
    sandboxCaps: isProduction ? "production" : "preview",
  });
  return {
    name: env.osWorkerName,
    account_id: env.cloudflareAccountId,
    routes: routes(env),
    ...bindings,
    vars: { ...bindings.vars, ...envShapedVars(env) },
  };
}

/**
 * Local dev's bindings: the shared worker bindings plus, when `pnpm dev`
 * threads its picked port through PORT, the dev server's own origin as
 * APP_CONFIG_BASE_URL — absolute-URL minting (e.g. signed project-file URLs
 * on `iterate-files--<slug>.localhost:<port>`) needs the worker to know it.
 * Deploy-time generation runs without PORT, so deployed envs are unaffected
 * (they get baseUrl from envShapedVars).
 */
function localDevBindings() {
  const bindings = workerBindings({ workerName: "os", accountId: PREVIEW_AND_DEV_ACCOUNT_ID });
  const localAuthJwks = localDevAuthJwks();
  return {
    ...bindings,
    vars: {
      ...bindings.vars,
      ...(process.env.PORT ? { APP_CONFIG_BASE_URL: `http://localhost:${process.env.PORT}` } : {}),
      // Local dev trusts forge-minted sessions by deriving the public key from
      // AUTH_FORGE_PRIVATE_JWK. Do not read APP_CONFIG_ITERATE_AUTH__JWKS from
      // Doppler here: stale snapshots caused login verification failures.
      ...(localAuthJwks ? { APP_CONFIG_ITERATE_AUTH__JWKS: localAuthJwks } : {}),
      // Same partner-model gap as the deployed non-prd envs (see
      // envShapedVars): local dev's env.AI remote proxy runs under wrangler
      // user auth on the preview/dev account and rejects openai/* with 2021.
      APP_CONFIG_DEFAULT_AGENT_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct",
    },
  };
}

const LOCAL_DEV_BINDINGS = localDevBindings();

function localDevAuthJwks() {
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!forgePrivateJwk) return undefined;

  const { d: _privateKey, ...publicJwk } = JSON.parse(forgePrivateJwk) as Record<
    string,
    unknown
  > & { d?: string };
  if (!publicJwk.kid || !publicJwk.kty) {
    throw new Error("AUTH_FORGE_PRIVATE_JWK must be a JWK with kid and kty");
  }
  return JSON.stringify({ keys: [publicJwk] });
}

export const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  // The top-level name is BOTH the local dev worker name and the service
  // identity: wrangler tags every `--env` deploy with `cf:service=<top-level
  // name>` + `cf:environment=<env>`, so it must be the env-less service name
  // ("os", not "os-dev") or observability queries grouped by service
  // mis-bucket every environment under a fake "dev" service.
  name: "os",
  main: "./src/worker.ts",
  compatibility_date: COMPATIBILITY_DATE,
  // Only NON-default flags belong here (we stay on the latest
  // compatibility_date, so anything default-on at that date is redundant).
  // nodejs_compat: @cloudflare/shell (repo git) and the dynamic worker
  // loader need Node APIs. global_fetch_strictly_public: same-zone
  // subrequests (auth worker and project egress) must traverse Worker routes
  // instead of going to origin.
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  // No `assets` here: the vite plugin injects the client build's assets
  // config into the OUTPUT wrangler.json (dist/…) that deploys actually use.
  // SSR + API paths reach the worker because no asset file matches them.
  exports: DO_EXPORTS,
  // Local dev: containers off by default so `pnpm dev` never requires Docker —
  // sandbox Durable Objects fail at their constructor until you opt in with
  // `OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm dev`, which builds the sandbox
  // image on Docker/OrbStack and pairs each container with a proxy-everything
  // egress sidecar (see docs/sandboxes.md). Deploys ignore the dev section.
  dev: { enable_containers: process.env.OS_SANDBOX_CONTAINER_LOCAL_DEV === "true" },
  // The dev/preview account, NOT "": local dev's ARTIFACTS binding is a
  // REMOTE binding (wrangler proxies it to the real service), and the repo
  // domain builds raw git remotes as https://<account>.artifacts.cloudflare.net/…
  // — an empty account makes every local repo seed/clone fail instantly on an
  // invalid host, which breaks project creation and sandbox provisioning.
  ...LOCAL_DEV_BINDINGS,
  // Local dev loads optional secrets and the env-shaping keys from Doppler
  // too (deployed envs get the latter as generated vars — see envShapedVars).
  // Keys already emitted as local-dev vars (APP_CONFIG_BASE_URL under `pnpm
  // dev`) are excluded: wrangler rejects a name bound as both var and secret.
  secrets: {
    required: [
      ...REQUIRED_SECRETS,
      ...OPTIONAL_SECRETS,
      ...ENV_SHAPED_KEYS.filter((key) => !(key in LOCAL_DEV_BINDINGS.vars)),
    ],
  },
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, envBlock(env)])),
};

/**
 * The builder sidecar's config. The builder is deliberately the minimum
 * possible worker around the bundler toolchain: a pure build function
 * (files in, artifact out) whose only binding is the artifact-cache KV — no
 * DOs, no routes, no secrets, no service bindings. Wrangler bundles
 * src/builder.ts directly (no vite); local dev runs it as an auxiliary
 * worker in the same workerd (vite.config.ts). Slated for deletion when
 * builds move into the sandbox container (tasks/os-sandbox-worker-builds.md).
 */
function builderEnvBlock(env: DeployedEnv) {
  return {
    name: builderWorkerName(env.osWorkerName),
    account_id: env.cloudflareAccountId,
    kv_namespaces: [{ binding: "WORKER_BUILD_CACHE", id: env.resources.workerBuildCacheKvId }],
    observability: OBSERVABILITY,
  };
}

export const builderConfig = {
  $schema: "node_modules/wrangler/config-schema.json",
  // Env-less service name — see the note on `config.name` above.
  name: "os-builder",
  main: "./src/builder.ts",
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat"],
  kv_namespaces: [{ binding: "WORKER_BUILD_CACHE", id: LOCAL_DEV_BUILD_CACHE_ID }],
  observability: OBSERVABILITY,
  env: Object.fromEntries(Object.entries(envs).map(([name, env]) => [name, builderEnvBlock(env)])),
};

/** Write wrangler.jsonc (gitignored) if changed — see writeGeneratedWranglerConfig. */
export const writeWranglerConfig = () => {
  writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.builder.jsonc", import.meta.url),
    appLabel: "apps/os (builder sidecar)",
    config: builderConfig,
  });
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/os",
    extraDocs: "apps/os/docs/worker-topology.md",
    config,
  });
};

/** Regenerate apps/os/wrangler{,.builder}.jsonc from the root envs.ts. */
export default function generateWranglerConfig() {
  console.log(`Wrote ${writeWranglerConfig()}`);
}

// The CLI runs only when invoked directly — deploy.ts and vite.config.ts
// import from this module without triggering a write.
void createCli({ ...import.meta, name: "generate-wrangler-config" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
