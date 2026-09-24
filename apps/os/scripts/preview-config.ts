// scripts/preview-config.ts — the pure half of scripts/preview.ts, what preview.test.ts pins: the
// preview's name (`pr<n>-<branch slug>`, cloudflare-os's), the parent it branches from (envs.ts
// `osEnvs.preview`) and the URL and resource names that follow from the two, which apps on top a
// change touches, the PR body's managed section, and the config `wrangler preview` reads — a
// transform of Vite's built Worker config, the shape of cloudflare-os's `buildPreviewConfigs`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { osEnvs } from "../../../envs.ts";
import { agents } from "../../agents/scripts/app.ts";
import { dash } from "../../dash/scripts/app.ts";
import { kit } from "../../kit/scripts/app.ts";
import { notes } from "../../notes/scripts/app.ts";
import { voice } from "../../voice/scripts/app.ts";
import type { StartApp } from "../../../scripts/lib/start-app.ts";
import { OBSERVABILITY } from "../../../scripts/lib/wrangler-config.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";

/** Beside Vite's built Worker config, so `main` and `assets.directory` resolve identically. */
export const PREVIEW_CONFIG_NAME = "dist/server/wrangler.preview.json";

/** THE PARENT of every per-PR preview: a Worker Preview is a branch of an existing worker
 *  (cloudflare-os `staging-config.ts`: "one must exist before a preview can be created"). This is
 *  that worker — os-next-preview on the dev/preview account (envs.ts). Nothing reads its data. */
export const PREVIEW_PARENT = osEnvs.preview!;

/** cloudflare-os's limit: the slug is the URL's first label, and KV/R2 names carry it too. */
export const MAX_PREVIEW_NAME_LENGTH = 28;

/** The apps on top, each previewed from its own parent worker (envs.ts `<app>Envs.preview`). */
export const APPS: StartApp[] = [dash, agents, notes, voice, kit];
/** A path that changes every app: the SDK they are built on, the shared UI, the shared deploy
 *  scripts, the env map. An app's own paths are `apps/<name>/`. */
const SHARED_APP_PATHS = [
  "packages/iterate/",
  "packages/shared/",
  "packages/ui/",
  "scripts/lib/",
  "envs.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];

// ── naming ─────────────────────────────────────────────────────────────────────────────────────

/** Slugify a ref into a legal preview name, truncating with a stable hash (cloudflare-os). */
export function slugifyPreviewName(raw: string, { reserve = 0 }: { reserve?: number } = {}) {
  const budget = MAX_PREVIEW_NAME_LENGTH - reserve;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "preview";
  if (slug.length <= budget) return slug;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 6);
  return `${slug.slice(0, budget - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

/** `pr<n>-<branch slug>`: recognizable, unique per pull request. Two live branches can slugify to
 *  one name (`feature/foo`, `feature-foo`) and would otherwise share an instance. Without a number
 *  — a local run — the bare slug, which the sweep judges on age alone. */
export function resolvePreviewName({ name, prNumber }: { name: string; prNumber?: string }) {
  const pr = (prNumber || "").trim();
  if (!/^\d+$/.test(pr)) return slugifyPreviewName(name);
  const prefix = `pr${pr}-`;
  return `${prefix}${slugifyPreviewName(name, { reserve: prefix.length })}`;
}

export function previewPullRequestNumber(previewName: string) {
  const match = /^pr(\d+)-/.exec(previewName);
  return match ? Number(match[1]) : undefined;
}

/** Cloudflare's 10061 from `wrangler preview`: "Cannot create binding for class
 *  'ControlPlaneDurableObject' that is not exported by the script. [code: 10061]" — the build binds
 *  a Durable Object class the preview does not have. An existing Worker Preview cannot gain a class
 *  it lacked when it was created (2026-09-23, #2888's ControlPlaneDurableObject: every existing PR
 *  preview failed, a new one passed), so scripts/preview.ts deletes the preview and creates it again. */
export function isDurableObjectClassNotExportedError(wranglerOutput: string) {
  return /Cannot create binding for class .* not exported by the script|\[code: 10061\]/.test(
    wranglerOutput,
  );
}

/** `https://<name>-<worker>.<subdomain>.workers.dev` — Cloudflare derives it from the preview's slug
 *  and the worker name, so every URL the config needs is known before anything deploys. */
export function previewUrl(previewName: string) {
  const host = new URL(PREVIEW_PARENT.baseUrl).hostname;
  const prefix = `${PREVIEW_PARENT.workerName}.`;
  if (!host.startsWith(prefix))
    throw new Error(`${host} is not the parent worker's workers.dev host`);
  return `https://${previewName}-${host}`;
}

/** Every preview-owned resource is `<worker>-<preview>-<binding>`, the name wrangler's preview
 *  auto-provisioning gives the KV namespaces and the R2 bucket; the Artifacts namespace follows it
 *  by hand. */
export const previewResourceName = (previewName: string, binding: string) =>
  `${PREVIEW_PARENT.workerName}-${previewName}-${binding}`;

/** The account resources a preview owns: the four kinds `previewResourceSuffixes` names. */
export type PreviewResourceKind = "kv" | "r2" | "d1" | "artifacts";

/** The suffix of every resource a preview owns (`previewResourceName(preview, suffix)`), by kind:
 *  the KV namespaces and the R2 bucket wrangler provisions for the template's bindings — the binding
 *  lowercased, `_` → `-` (workers-sdk `getPreviewResourceName`: `ITX_KV` → `…-itx-kv`) — and the
 *  Artifacts namespace scripts/preview.ts creates. The `db` D1 is no longer created (the control plane
 *  is a Durable Object now, not D1); its suffix stays so the sweep still recognizes and deletes the
 *  D1s earlier previews left behind. What deletePreview deletes and the sweep recognizes. */
export function previewResourceSuffixes(
  template = readWranglerBase(),
): Record<PreviewResourceKind, string[]> {
  const suffix = ({ binding }: { binding: string }) => binding.toLowerCase().replaceAll("_", "-");
  return {
    kv: template.kv_namespaces.map(suffix),
    r2: template.r2_buckets.map(suffix),
    d1: ["db"],
    artifacts: ["repos"],
  };
}

/** The preview a per-preview resource name encodes — `previewResourceName`'s inverse — or undefined
 *  for a name of another shape: the parent's own (`os-next-preview-repos`), another worker's,
 *  another binding's. How the sweep reads a leftover resource (scripts/preview-sweep.ts). */
export function previewNameOfResource(resourceName: string, binding: string) {
  const prefix = `${PREVIEW_PARENT.workerName}-`;
  const suffix = `-${binding}`;
  if (!resourceName.startsWith(prefix) || !resourceName.endsWith(suffix)) return undefined;
  return resourceName.slice(prefix.length, -suffix.length) || undefined;
}

/** Which apps on top a set of changed paths touches: an app's own directory, or a shared path
 *  (then every app). */
export function changedApps(changedPaths: string[], apps = APPS) {
  if (changedPaths.some((file) => SHARED_APP_PATHS.some((shared) => file.startsWith(shared))))
    return apps;
  return apps.filter((app) => changedPaths.some((file) => file.startsWith(`apps/${app.name}/`)));
}

// ── the PR body's managed section ──────────────────────────────────────────────────────────────

const SECTION_BEGIN = "<!-- os-next-preview:begin -->";
const SECTION_END = "<!-- os-next-preview:end -->";

/** Replace the managed section between the markers, or append one. Everything a person wrote
 *  around it is kept verbatim. */
export function splicePullRequestBody(body: string, section: string) {
  const block = `${SECTION_BEGIN}\n${section.trim()}\n${SECTION_END}`;
  const begin = body.indexOf(SECTION_BEGIN);
  const end = body.indexOf(SECTION_END, begin);
  if (begin >= 0 && end > begin) {
    return body.slice(0, begin) + block + body.slice(end + SECTION_END.length);
  }
  const kept = body.trimEnd();
  return `${kept ? `${kept}\n\n` : ""}${block}\n`;
}

/** The URL, the deployment, the apps on top previewed this run; the operations (reset, e2e, delete,
 *  the laptop commands) are the README's, linked, not spelled here a second time. */
export function renderPullRequestSection(input: {
  previewName: string;
  url: string;
  deploymentId: string;
  dashboardUrl: string;
  apps: { name: string; url: string }[];
  /** Which commit the run deployed and tested (scripts/ci/preview-tested-commit.ts). */
  testedCommit?: string;
}) {
  return [
    `### OS preview: \`${input.previewName}\``,
    "",
    `**${input.url}** · deployment \`${input.deploymentId.slice(0, 8)}\` · [Cloudflare dashboard](${input.dashboardUrl}) · deleted when this PR closes`,
    "",
    ...(input.testedCommit ? [`Built and tested from ${input.testedCommit}.`, ""] : []),
    ...(input.apps.length > 0
      ? [
          "| App on top, signed in against this preview | |",
          "| --- | --- |",
          ...input.apps.map((app) => `| ${app.name} | ${app.url} |`),
        ]
      : ["No app preview was deployed in this run."]),
    "",
    "Every push redeploys it in place. Reset, e2e, delete and the laptop commands: [apps/os/README.md](https://github.com/iterate/iterate/blob/main/apps/os/README.md).",
  ].join("\n");
}

// ── the config `wrangler preview` reads ────────────────────────────────────────────────────────

/** A resource list with only its `binding` names kept — how wrangler is told to auto-provision a
 *  fresh one per preview (cloudflare-os `previewResourceBindings`). */
const bindingOnly = (resources: { binding: string }[] | undefined) =>
  (resources || []).map(({ binding }) => ({ binding }));

/** The config `wrangler preview` reads, as a pure function of Vite's built Worker config and
 *  the preview's name — the shape of cloudflare-os's `buildPreviewConfigs`, unit-tested
 *  in preview.test.ts. The top level names the parent (which worker, which account, the entry, the
 *  assets) and declares the Durable Object classes as a legacy `migrations` entry: the pkg.pr.new
 *  wrangler build that provisions per-preview KV and R2 predates `exports`, and a preview
 *  deployment provisions its own namespaces from that entry. The `previews` block is the ONE
 *  preview's bindings — a preview inherits nothing from the top level, so every binding the worker
 *  reads is here: KV and R2 binding-only (auto-provisioned) and the
 *  Artifacts namespace by name. Its `urls` name the preview's own origin, projects as paths,
 *  and its Dash when deployed; the secrets (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY`) are the parent's Previews
 *  settings, inherited. */
export function previewWranglerConfig(input: {
  template: Record<string, any>;
  previewName: string;
  dashOrigin?: string;
}) {
  const { template: base, previewName } = input;
  return {
    name: PREVIEW_PARENT.workerName,
    account_id: PREVIEW_PARENT.cloudflareAccountId,
    main: base.main,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    preview_urls: true,
    no_bundle: base.no_bundle,
    rules: base.rules,
    assets: base.assets,
    // Tombstones retire existing namespaces; a preview provisions only the live SQLite classes.
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: Object.keys(base.exports).filter(
          (name) => base.exports[name].storage === "sqlite",
        ),
      },
    ],
    previews: {
      observability: OBSERVABILITY,
      limits: base.limits,
      durable_objects: base.durable_objects,
      worker_loaders: base.worker_loaders,
      ai: base.ai,
      browser: base.browser,
      send_email: base.send_email,
      version_metadata: base.version_metadata,
      kv_namespaces: bindingOnly(base.kv_namespaces),
      r2_buckets: bindingOnly(base.r2_buckets),
      artifacts: base.artifacts.map(({ binding }: { binding: string }) => ({
        binding,
        namespace: previewResourceName(previewName, "repos"),
      })),
      vars: {
        APP_CONFIG_URLS__OS: previewUrl(previewName),
        APP_CONFIG_URLS__DASH: input.dashOrigin,
        APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify(PREVIEW_PARENT.ingressRouting),
      },
    },
  };
}

/** Write a preview config beside Vite's built config and return its path. */
export function writePreviewWranglerConfig(input: { previewName: string; dashOrigin?: string }) {
  const configUrl = new URL(`../${PREVIEW_CONFIG_NAME}`, import.meta.url);
  const built = JSON.parse(
    readFileSync(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  writeFileSync(
    configUrl,
    `${JSON.stringify(previewWranglerConfig({ template: built, ...input }), null, 2)}\n`,
  );
  return fileURLToPath(configUrl);
}
