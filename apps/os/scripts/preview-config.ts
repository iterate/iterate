// scripts/preview-config.ts — the pure half of scripts/preview.ts, what preview.test.ts pins: the
// preview's name (`pr<n>-<branch slug>`, cloudflare-os's), the parent it branches from (envs.ts
// `osEnvs.preview`) and the URL and resource names that follow from the two, which apps on top a
// change touches, the PR body's managed section and its status line, the template quick-launch
// links, the config `wrangler preview` reads — a
// transform of Vite's built Worker config, the shape of cloudflare-os's `buildPreviewConfigs` —
// and whether node_modules was installed from the checkout's lockfile.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { osEnvs } from "../../../envs.ts";
import { agents } from "../../agents/scripts/app.ts";
import { dash } from "../../dash/scripts/app.ts";
import { kit } from "../../kit/scripts/app.ts";
import { notes } from "../../notes/scripts/app.ts";
import { voice } from "../../voice/scripts/app.ts";
import type { StartApp } from "../../../scripts/lib/start-app.ts";
import { OBSERVABILITY } from "../../../scripts/lib/wrangler-config.ts";
import { TEST_LINK_EMAIL_DOMAIN } from "../src/test-link.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";

/** Beside Vite's built Worker config, so `main` and `assets.directory` resolve identically. */
export const PREVIEW_CONFIG_NAME = "dist/server/wrangler.preview.json";

/** THE PARENT of every per-PR preview: a Worker Preview is a branch of an existing worker
 *  (cloudflare-os `staging-config.ts`: "one must exist before a preview can be created"). This is
 *  that worker — os-preview on the dev/preview account (envs.ts). Nothing reads its data. */
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

/** An app on top's preview URL, `https://<name>-<its parent's workers.dev host>` — known before
 *  anything deploys, by the same rule as apps/os's `previewUrl`. */
export const appPreviewUrl = (app: StartApp, previewName: string) =>
  `https://${previewName}-${new URL(app.envs.preview!.baseUrl).hostname}`;

/** The apps a run previews, by name, at their preview URLs: every link between this preview's
 *  apps — the dash the OS preview's landing page names (`APP_CONFIG_URLS__DASH`), and each app
 *  preview's `ITERATE_APP_ORIGINS` (scripts/lib/start-app.ts: the dash's directory of apps, Kit's
 *  link to the sessions in the dash). An app the run does not deploy (`--apps auto|none`) is named
 *  nowhere: a link leads into this PR's preview or does not exist, never to production, where a
 *  preview's projects do not. */
export function appPreviewOrigins(apps: StartApp[], previewName: string) {
  return Object.fromEntries(apps.map((app) => [app.name, appPreviewUrl(app, previewName)]));
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
 *  for a name of another shape: the parent's own (`os-preview-repos`), another worker's,
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

const SECTION_BEGIN = "<!-- os-preview:begin -->";
const SECTION_END = "<!-- os-preview:end -->";

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

// ── the status line, nested in the managed section ─────────────────────────────────────────────

const STATUS_BEGIN = "<!-- os-preview-status:begin -->";
const STATUS_END = "<!-- os-preview-status:end -->";

/** Where a PR's preview stands, as its body's status line says: the Deploy preview job writes
 *  `deploying`, then `deployed` with the whole section or `deploy failed`. */
export type PreviewStatus = {
  state: "deploying" | "deployed" | "deploy failed";
  /** the commit the job checked out: the PR merged into main, or the head alone */
  commit: string;
  /** the CI job that wrote it (Depot's `DEPOT_JOB_URL`); absent from a laptop */
  runUrl?: string;
  at: Date;
  /** a failure's error: its first line is the summary, the rest's tail goes under `<details>` */
  error?: string;
};

/** The suites a deployed preview runs, each its own CI job and check (preview-os.yml), by their
 *  names there: `e2e`, the vitest e2e suite, and `specs`, the Playwright specs. Their lines follow
 *  the status line in SUITE_ORDER. */
export const PREVIEW_SUITES = { e2e: "E2E tests", specs: "Browser specs" } as const;
export type PreviewSuite = keyof typeof PREVIEW_SUITES;
const SUITE_ORDER: PreviewSuite[] = ["e2e", "specs"];

/** A suite's line under the status line, which its own job writes once it ran: passed or failed,
 *  on the commit it tested. Both jobs run at once, so each rewrites its own line alone. */
export type PreviewSuiteStatus = Omit<PreviewStatus, "state"> & {
  suite: PreviewSuite;
  state: "passed" | "failed";
};

/** The last `count` lines of a command's output, colour codes stripped: what a failure keeps. */
export function lastLines(text: string, count: number) {
  // eslint-disable-next-line no-control-regex -- the ANSI escape is the point
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
  return plain.split("\n").slice(-count).join("\n");
}

/** The status line or a suite's, and on a failure its one-line summary and the error's tail,
 *  folded. After a failed deploy the rest of the section is the last good deploy's, and the line
 *  says so. */
export function renderPreviewStatus(status: PreviewStatus | PreviewSuiteStatus) {
  const label = "suite" in status ? PREVIEW_SUITES[status.suite] : "Status";
  const line = [
    `${label}: **${status.state}** on \`${status.commit.slice(0, 9)}\``,
    ...(status.runUrl ? [`[CI job ↗](${status.runUrl})`] : []),
    `updated ${status.at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ].join(" · ");
  const [summary = "", ...rest] = (status.error || "").trim().split("\n");
  const detail = lastLines(rest.join("\n"), 40).slice(-4000).trim();
  // a fence longer than any backtick run in the output
  const fence = "`".repeat(
    Math.max(3, ...(detail.match(/`+/g) || []).map((run) => run.length + 1)),
  );
  return [
    line,
    ...(status.state === "deploy failed"
      ? ["", "The links below, if any, are the last successful deploy's."]
      : []),
    ...(summary ? ["", `\`${summary.replaceAll("`", "'")}\``] : []),
    ...(detail
      ? [
          "",
          "<details><summary>Error output (tail)</summary>",
          "",
          fence,
          detail,
          fence,
          "",
          "</details>",
        ]
      : []),
  ].join("\n");
}

const statusBlock = (status: PreviewStatus) =>
  `${STATUS_BEGIN}\n${renderPreviewStatus(status)}\n${STATUS_END}`;
const suiteMarkers = (suite: PreviewSuite) =>
  [`<!-- os-preview-${suite}:begin -->`, `<!-- os-preview-${suite}:end -->`] as const;
const suiteBlock = (status: PreviewSuiteStatus) => {
  const [begin, end] = suiteMarkers(status.suite);
  return `${begin}\n${renderPreviewStatus(status)}\n${end}`;
};

/** Rewrite the managed section's inside with `rewrite`, or make the body's section `block` alone
 *  when it has none (the first deploy failed before writing one). */
function spliceSection(body: string, block: string, rewrite: (inner: string) => string) {
  const begin = body.indexOf(SECTION_BEGIN);
  const end = body.indexOf(SECTION_END, begin);
  if (begin < 0 || end < begin) return splicePullRequestBody(body, block);
  const inner = body.slice(begin + SECTION_BEGIN.length, end);
  return body.slice(0, begin + SECTION_BEGIN.length) + rewrite(inner) + body.slice(end);
}

/** `inner` with the block between `begin` and `end` replaced by `block`, or undefined without one. */
function replaceBlock(inner: string, begin: string, end: string, block: string) {
  const from = inner.indexOf(begin);
  const to = inner.indexOf(end, from);
  if (from < 0 || to < from) return undefined;
  return inner.slice(0, from) + block + inner.slice(to + end.length);
}

/** Rewrite the status line alone, leaving the rest of the managed section as it is: in place, at
 *  the top of a section that has none, or as the whole section of a body that has none. A new
 *  deploy (`deploying`) drops the suites' lines, which were the previous deploy's. */
export function splicePreviewStatus(body: string, status: PreviewStatus) {
  const block = statusBlock(status);
  return spliceSection(body, block, (inner) => {
    const kept =
      status.state === "deploying"
        ? SUITE_ORDER.reduce((text, suite) => {
            const [begin, end] = suiteMarkers(suite);
            return replaceBlock(text, `\n${begin}`, end, "") ?? text;
          }, inner)
        : inner;
    return (
      replaceBlock(kept, STATUS_BEGIN, STATUS_END, block) ??
      `\n${block}\n${kept.replace(/^\n/, "")}`
    );
  });
}

/** Rewrite one suite's line alone: in place, else after the status line and the lines of the
 *  suites before it (SUITE_ORDER), else at the top of the section. */
export function splicePreviewSuite(body: string, status: PreviewSuiteStatus) {
  const block = suiteBlock(status);
  const [begin, end] = suiteMarkers(status.suite);
  return spliceSection(body, block, (inner) => {
    const replaced = replaceBlock(inner, begin, end, block);
    if (replaced) return replaced;
    const anchors = [
      STATUS_END,
      ...SUITE_ORDER.slice(0, SUITE_ORDER.indexOf(status.suite)).map(
        (suite) => suiteMarkers(suite)[1],
      ),
    ];
    const at = Math.max(
      ...anchors.map((marker) =>
        inner.includes(marker) ? inner.indexOf(marker) + marker.length : -1,
      ),
    );
    return at < 0
      ? `\n${block}\n${inner.replace(/^\n/, "")}`
      : `${inner.slice(0, at)}\n${block}${inner.slice(at)}`;
  });
}

/** A deploy's status writes around its steps. The PR body has no conditional update, so the last
 *  write wins (scripts/preview.ts `writePullRequestBody`): `deploying` goes out beside the steps,
 *  which do not wait for GitHub, and what follows it lands after it — `deploy failed` here, and the
 *  steps' `deployed` section, which awaits the `deploying` write it is handed. `write` never
 *  rejects: a status write that fails is logged, never the deploy's failure. */
export async function deployWithStatus(
  write: (
    status: { state: "deploying" } | { state: "deploy failed"; error: unknown },
  ) => Promise<void>,
  steps: (deploying: Promise<void>) => Promise<void>,
) {
  const deploying = write({ state: "deploying" });
  try {
    await steps(deploying);
  } catch (error) {
    await deploying;
    await write({ state: "deploy failed", error });
    throw error;
  }
}

// ── template quick-launch links ────────────────────────────────────────────────────────────────

/** The config templates a project can be born from: the directories of configs/. */
export function configTemplateNames(repoRoot: string) {
  return readdirSync(path.join(repoRoot, "configs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Where each template's quick-launch link lands: the Dash's New project sheet with it chosen
 *  (`/projects?new=1&template=<name>`, apps/dash `projects/index.tsx`). A template this PR changes
 *  is named by the PR head's copy instead (`github:iterate/iterate#<head>&path:configs/<name>`,
 *  the custom field prefilled), so the project is born from the unmerged template. */
export function templateQuickLaunches(input: {
  dashUrl: string;
  templates: string[];
  changedPaths: string[];
  headSha: string;
}) {
  return input.templates.map((name) => {
    const changed = input.changedPaths.some((file) => file.startsWith(`configs/${name}/`));
    const template = changed
      ? `github:iterate/iterate#${input.headSha}&path:configs/${name}`
      : name;
    return {
      name,
      ...(changed && { fromHead: input.headSha }),
      next: `${input.dashUrl}/projects?${new URLSearchParams({ new: "1", template })}`,
    };
  });
}

/** The status line, the URL, the deployment, the apps on top previewed this run and, on a PR, the
 *  one-click `Sign in ↗` links (src/test-link.ts) — the heading's into the Dash (or the issuer's own
 *  page), each app's into that app, and with the Dash one per config template into its New project
 *  sheet; the operations (reset, e2e, delete, the laptop commands) are the README's, linked, not
 *  spelled here a second time. */
export function renderPullRequestSection(input: {
  previewName: string;
  status: PreviewStatus;
  url: string;
  deploymentId: string;
  dashboardUrl: string;
  apps: { name: string; url: string }[];
  /** Which commit the run deployed (scripts/ci/preview-tested-commit.ts). */
  testedCommit?: string;
  /** The test person's links (scripts/preview.ts `previewSignIn`): only with a PR number. */
  signIn?: {
    heading: string;
    /** app name → its link */
    apps: Record<string, string>;
    /** one per config template, into the Dash's New project sheet: only when the Dash was previewed */
    templates: {
      name: string;
      link: string;
      /** the PR head the link's template is read at */ fromHead?: string;
    }[];
    email: string;
    project: string;
    /** whether CI's `projects.create` of `project` succeeded this run */
    seeded: boolean;
  };
}) {
  const { signIn } = input;
  return [
    `### OS preview: \`${input.previewName}\``,
    "",
    statusBlock(input.status),
    "",
    `**${input.url}**${signIn ? ` · [Sign in ↗](${signIn.heading})` : ""} · deployment \`${input.deploymentId.slice(0, 8)}\` · [Cloudflare dashboard](${input.dashboardUrl}) · deleted when this PR closes`,
    "",
    ...(input.testedCommit ? [`Deployed from ${input.testedCommit}.`, ""] : []),
    ...(input.apps.length > 0
      ? signIn
        ? [
            "| App on top, signed in against this preview | | |",
            "| --- | --- | --- |",
            ...input.apps.map(
              (app) =>
                `| ${app.name} | ${app.url} | ${signIn.apps[app.name] ? `[Sign in ↗](${signIn.apps[app.name]})` : ""} |`,
            ),
          ]
        : [
            "| App on top, signed in against this preview | |",
            "| --- | --- |",
            ...input.apps.map((app) => `| ${app.name} | ${app.url} |`),
          ]
      : ["No app preview was deployed in this run."]),
    "",
    ...(signIn?.templates.length
      ? [
          `New project from template: ${signIn.templates
            .map(
              (template) =>
                `[${template.name}${template.fromHead ? ` at this PR's \`${template.fromHead.slice(0, 9)}\`` : ""} ↗](${template.link})`,
            )
            .join(" · ")}`,
          "",
        ]
      : []),
    ...(signIn
      ? [
          `\`Sign in ↗\` signs you in as \`${signIn.email}\` with project \`${signIn.project}\`, no password and no Allow page: the link is signed for this preview only and expires in 14 days; every push mints a fresh one.${signIn.seeded ? "" : ` Seeding \`${signIn.project}\` failed this run (the deploy log says why), so the apps ask for consent.`}`,
          "",
        ]
      : []),
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
 *  Artifacts namespace by name. Its vars name the preview's own origin, projects as paths and its
 *  Dash when deployed, and turn the one-click sign-in links on; the secrets (`APP_CONFIG`,
 *  `APP_CONFIG_SECRETS__KEY`) are the parent's Previews settings, inherited. */
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
        // THE ONE-CLICK SIGN-IN (src/test-link.ts), on for a per-PR preview only: this config is
        // only ever what `wrangler preview` reads (deploy.ts never does), and app-config.ts refuses
        // the block off a workers.dev origin besides. The PR body's `Sign in ↗` links redeem here.
        APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: TEST_LINK_EMAIL_DOMAIN,
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

/** A deploy bundles whatever node_modules holds, so an install older than pnpm-lock.yaml would ship
 *  stale dependencies. pnpm keeps the lockfile it installed from as node_modules/.pnpm/lock.yaml:
 *  the same bytes prove the install current, whatever the mtimes say. They say the wrong thing in
 *  CI: checking out the PR head, then the PR merged into main, rewrites pnpm-lock.yaml with
 *  main's content and a new mtime, and scripts/depot-ci/dependencies.mjs rightly reuses the
 *  image's node_modules baked from that same lockfile (2026-09-24, four Preview OS deploys failed
 *  on identical content). Only when the content differs does the laptop rule decide: a lockfile
 *  newer than node_modules/.modules.yaml means `pnpm install` has not run since it changed. */
export function assertFreshInstall(root: string) {
  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"));
  const installedLockfile = readOptional(path.join(root, "node_modules", ".pnpm", "lock.yaml"));
  if (installedLockfile?.equals(lockfile)) return;
  const lockfileTime = statSync(path.join(root, "pnpm-lock.yaml")).mtimeMs;
  const installTime = statSync(path.join(root, "node_modules", ".modules.yaml"), {
    throwIfNoEntry: false,
  })?.mtimeMs;
  if (installTime === undefined || lockfileTime > installTime)
    throw new Error(
      `pnpm-lock.yaml is newer than node_modules and ${installedLockfile ? "differs from" : "has no copy in"} node_modules/.pnpm/lock.yaml: run \`pnpm install\` first`,
    );
}

function readOptional(file: string) {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
