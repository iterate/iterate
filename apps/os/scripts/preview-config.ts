// scripts/preview-config.ts — the pure half of scripts/preview.ts, what preview.test.ts pins: the
// name of a run's per-commit deployment (`pr<n>-<sha7>`, or a slug's; envs.ts `previewDeployment`
// derives every worker, URL and resource from it), the PR body's managed section and its fold into
// a previous commit's, the template quick-launch links, and whether node_modules was installed from
// the checkout's lockfile.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { osEnvs, previewDeployment } from "../../../envs.ts";
import { agents } from "../../agents/scripts/app.ts";
import { dash } from "../../dash/scripts/app.ts";
import { kit } from "../../kit/scripts/app.ts";
import { notes } from "../../notes/scripts/app.ts";
import { admin } from "../../admin/scripts/app.ts";
import { voice } from "../../voice/scripts/app.ts";
import type { StartApp } from "../../../scripts/lib/start-app.ts";

/** MAIN ON THE DEV/PREVIEW ACCOUNT (envs.ts `osEnvs.preview`): the account every per-commit
 *  deployment lives on, whose Doppler config (`os/preview`) holds its Cloudflare credentials and
 *  the two secrets each apps/os deploy ships. preview-parents.yml redeploys it from main. */
export const MAIN_ON_DEV = osEnvs.preview!;

/** The longest prefix a deployment name takes (envs.ts `previewDeployment`): every worker and
 *  resource name of the set stays under Cloudflare's 63 characters. */
export const MAX_PREVIEW_PREFIX_LENGTH = 28;

/** The apps on top, each deployed beside apps/os as `<deployment>-<app>`. */
export const APPS: StartApp[] = [dash, agents, notes, voice, kit, admin];

// ── naming ─────────────────────────────────────────────────────────────────────────────────────

/** Slugify a ref into a legal prefix, truncating with a stable hash (cloudflare-os). */
export function slugifyPreviewName(raw: string) {
  const budget = MAX_PREVIEW_PREFIX_LENGTH;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "preview";
  if (slug.length <= budget) return slug;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 6);
  return `${slug.slice(0, budget - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

/** The prefix every deployment of a run's owner shares: `pr<n>` for a pull request, one per PR
 *  whatever its branch is called; without a number the slugified name — a CI workflow's own
 *  (`main`, `latency`, `real-model`), a soak's, a laptop's experiment — which the sweep judges on
 *  age alone. */
export function resolvePreviewPrefix({ name, prNumber }: { name?: string; prNumber?: string }) {
  const pr = (prNumber || "").trim();
  if (/^\d+$/.test(pr)) return `pr${pr}`;
  if (!name) throw new Error("a deployment needs a PR number (--pr) or a name (--name)");
  return slugifyPreviewName(name);
}

/** THE DEPLOYMENT a run deploys or tests: `<prefix>-<sha7>` of the commit it tests (the PR merged
 *  into main in CI, scripts/ci/preview-tested-commit.ts), so a push that tests a new commit gets a
 *  new set of workers, and a retry of the same commit redeploys the same set. */
export function previewDeploymentName(prefix: string, commit: string) {
  const name = `${prefix}-${commit.slice(0, 7)}`;
  const deployment = previewDeployment(name);
  if (!deployment) throw new Error(`${name} is not a deployment name: <prefix>-<7 hex digits>`);
  return deployment.name;
}

export function previewPullRequestNumber(prefix: string) {
  const match = /^pr(\d+)$/.exec(prefix);
  return match ? Number(match[1]) : undefined;
}

/** A deployment's apps/os origin, and its apps' by name: envs.ts `previewDeployment`, for a name
 *  this module made. */
export function previewDeploymentUrls(name: string) {
  const deployment = previewDeployment(name);
  if (!deployment) throw new Error(`${name} is not a deployment name`);
  return {
    os: deployment.os.baseUrl,
    apps: Object.fromEntries(
      Object.entries(deployment.apps).map(([app, env]) => [app, env.baseUrl]),
    ) as Record<string, string>,
  };
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

// ── a previous commit's section ────────────────────────────────────────────────────────────────

/** The heading of a section this module wrote: `### Preview \`<deployment>\``, or, before per-commit
 *  deployments, `### OS preview: \`<preview>\``. */
const SECTION_HEADING = /^### (?:OS preview: |Preview )`([^`]+)`\n*/;

/** A deploy starts by folding the section it will replace into a `<details>`, so the links read as
 *  a previous commit's at a glance, and a deploy that fails leaves them folded; the next deploy
 *  that lands writes the section unfolded. Once change detection lands
 *  (tasks/ci-change-detection.md), fold only after it has decided to deploy: a push that reuses the
 *  deployment leaves it current. A body with no section, or one already folded, stays as it is. */
export function foldPreviousPreviewSection(body: string) {
  const begin = body.indexOf(SECTION_BEGIN);
  const end = body.indexOf(SECTION_END, begin);
  if (begin < 0 || end < begin) return body;
  const inner = body.slice(begin + SECTION_BEGIN.length, end).trim();
  if (inner.startsWith("<details>")) return body;
  const heading = SECTION_HEADING.exec(inner);
  const summary = heading
    ? `Previous commit's deployment: <code>${heading[1]}</code>`
    : "Previous commit's deployment";
  return splicePullRequestBody(
    body,
    `<details><summary>${summary}</summary>\n\n${heading ? inner.slice(heading[0].length) : inner}\n\n</details>`,
  );
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

/** THE SECTION: quick links for a reader who already knows how per-commit deployments work
 *  (docs/dev-environments.md). It never explains itself; what needs explaining goes in a comment
 *  here. The CI checks carry the deploy's and the suites' verdicts, so it has no status of its own.
 *  One row per worker, apps/os first: its origin, its one-click `Sign in ↗` (src/test-link.ts, as
 *  the PR's test person: apps/os's into the Dash's project `pr<N>`, each app's into that app;
 *  signed for this deployment, 14 days) and its Cloudflare dashboard page. With the Dash, one
 *  quick-launch link per config template into its New project sheet (`templateQuickLaunches`). And,
 *  only when CI's seed of the test project failed, that fact: the links then ask for consent. */
export function renderPullRequestSection(input: {
  /** the deployment's name, `pr<n>-<sha7>` */
  deployment: string;
  workers: { name: string; url: string; signIn: string; dashboardUrl: string }[];
  templates: { name: string; link: string; fromHead?: string }[];
  seed: { project: string; seeded: boolean };
}) {
  return [
    `### Preview \`${input.deployment}\``,
    "",
    "| apps | | |",
    "| --- | --- | --- |",
    ...input.workers.map(
      (worker) =>
        `| [${worker.name}](${worker.url}) | [Sign in ↗](${worker.signIn}) | [Cloudflare dashboard](${worker.dashboardUrl}) |`,
    ),
    ...(input.templates.length
      ? [
          "",
          `New project from template: ${input.templates
            .map(
              (template) =>
                `[${template.name}${template.fromHead ? ` at this PR's \`${template.fromHead.slice(0, 9)}\`` : ""} ↗](${template.link})`,
            )
            .join(" · ")}`,
        ]
      : []),
    ...(input.seed.seeded
      ? []
      : [
          "",
          `Seeding \`${input.seed.project}\` failed (the deploy log says why): the links ask for consent.`,
        ]),
  ].join("\n");
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
