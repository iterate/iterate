// scripts/preview-config.ts — the pure half of scripts/preview.ts, what preview.test.ts pins: the
// name of a run's per-commit deployment (`pr<n>-<sha7>`, or a slug's; envs.ts `previewDeployment`
// derives every worker, URL and resource from it), the PR body's managed section, its fold into a
// previous commit's and the write that puts them there, the sign-in and template quick-launch
// links, what on the account is never a preview's, and whether node_modules was installed from the
// checkout's lockfile.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ciReportsEnvs,
  osEnvs,
  osResourceNames,
  previewDeployment,
  spaEnvs,
} from "../../../envs.ts";
import { agents } from "../../agents/scripts/app.ts";
import { dash } from "../../dash/scripts/app.ts";
import { kit } from "../../kit/scripts/app.ts";
import { notes } from "../../notes/scripts/app.ts";
import { admin } from "../../admin/scripts/app.ts";
import { voice } from "../../voice/scripts/app.ts";
import { markedSection, replaceMarkedSection } from "../../../scripts/ci/markdown-annotator.ts";
import type { StartApp } from "../../../scripts/lib/start-app.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";

/** MAIN ON THE DEV/PREVIEW ACCOUNT (envs.ts `osEnvs.preview`): the account every per-commit
 *  deployment lives on, whose Doppler config (`os/preview`) holds its Cloudflare credentials and
 *  the two secrets each apps/os deploy ships. preview-parents.yml redeploys it from main. */
export const MAIN_ON_DEV = osEnvs.preview!;

/** The longest prefix a deployment name takes (envs.ts `previewDeployment`): every worker and
 *  resource name of the set stays under Cloudflare's 63 characters. */
export const MAX_PREVIEW_PREFIX_LENGTH = 28;

/** The apps on top, each deployed beside apps/os as `<deployment>-<app>`. */
export const APPS: StartApp[] = [dash, agents, notes, voice, kit, admin];

/** THE FORMER PARENTS: `os-preview` and the apps' `<app>-preview` workers, which no deploy names
 *  (main on dev is `os` and `<app>`). The sweep deletes the Worker Previews still hanging
 *  from them, as it does main on dev's (scripts/preview.ts `deleteLegacyWorkerPreviews`), then each
 *  worker with everything under its name (preview-sweep.ts `planFormerParents`): each holds a
 *  Durable Object namespace per class of the account's 500. */
export const FORMER_PARENTS = [
  "os-preview",
  "dash-preview",
  "agents-preview",
  "notes-preview",
  "voice-preview",
  "kit-preview",
];

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
    ),
  };
}

// ── what on the account is never a preview's ──────────────────────────────────────────────────

/** THE ACCOUNT'S OWN RESOURCES: every OS deployment's in envs.ts (main on dev's `os-parent-files`,
 *  `os-parent-db`, …) and local dev's (wrangler.base.jsonc: `os-dev-repos`, …). The sweep never
 *  deletes one (preview-sweep.ts `planFormerParents`). KV is bound by id, so only its titles count. */
export function accountResourceNames(template = readWranglerBase()) {
  return new Set([
    ...Object.values(osEnvs).flatMap((env) => [
      `${env.resourceNamePrefix}-oauth`,
      `${env.resourceNamePrefix}-itx`,
      ...Object.values(osResourceNames(env.resourceNamePrefix)),
    ]),
    ...template.r2_buckets.map((bucket: { bucket_name: string }) => bucket.bucket_name),
    ...template.d1_databases.map((database: { database_name: string }) => database.database_name),
    ...template.artifacts.map((artifacts: { namespace: string }) => artifacts.namespace),
  ]);
}

/** envs.ts's workers on the dev/preview account: main on dev (`os`, each app's) and every other
 *  deployment there (the CI reports viewer, the SPA example). The sweep never deletes one. */
export function accountWorkerNames() {
  return new Set(
    [osEnvs, ...APPS.map((app) => app.envs), spaEnvs, ciReportsEnvs]
      .flatMap((envs) => Object.values(envs))
      .filter((env) => env.cloudflareAccountId === MAIN_ON_DEV.cloudflareAccountId)
      .map((env) => env.workerName),
  );
}

// ── the PR body's managed section ──────────────────────────────────────────────────────────────

/** The label of the PR body's managed section (scripts/ci/markdown-annotator.ts):
 *  `<!-- os-preview -->…<!-- /os-preview -->`. */
export const PREVIEW_SECTION = "os-preview";

// ── a previous commit's section ────────────────────────────────────────────────────────────────

/** The heading of a section this module writes, `### Preview \`<deployment>\``. */
const SECTION_HEADING = /^### Preview `([^`]+)`\n*/;

/** A deploy starts by folding the section it will replace into a `<details>`, so the links read as
 *  a previous commit's at a glance, and a deploy that fails leaves them folded; the next deploy
 *  that lands writes the section unfolded. Once change detection lands
 *  (tasks/ci-change-detection.md), fold only after it has decided to deploy: a push that reuses the
 *  deployment leaves it current. A body with no section, or one already folded, stays as it is. */
export function foldPreviousPreviewSection(body: string) {
  const inner = markedSection(body, PREVIEW_SECTION);
  if (!inner || inner.startsWith("<details>")) return body;
  const heading = SECTION_HEADING.exec(inner);
  const summary = heading
    ? `Previous commit's deployment: <code>${heading[1]}</code>`
    : "Previous commit's deployment";
  return replaceMarkedSection(
    body,
    PREVIEW_SECTION,
    `<details><summary>${summary}</summary>\n\n${heading ? inner.slice(heading[0].length) : inner}\n\n</details>`,
  );
}

/** A pull request's body as GitHub holds it: read, and replaced whole. */
export type PullRequestBody = {
  number: string;
  read: () => Promise<string>;
  /** one PATCH, not asked again on a 5xx (scripts/ci/github.ts `askOnce`) */
  replace: (body: string) => Promise<void>;
};

/** Read, splice, write, read back: the PR body has no conditional update, so a person editing the
 *  description in the same seconds, or the LOC report writing its own section, could lose one
 *  write or the other. Reading it back and re-splicing onto whatever is there now converges on
 *  both edits within a few rounds. `what` names the write in the log: the fold of the previous
 *  section, or the section. Our own writes never overlap: the deploy's run in order in its job.
 *  Every PATCH goes out once, straight after its read: a failed one is not sent again with a body
 *  read seconds earlier; the next round reads anew 5 s later, and finds the body written when the
 *  failure was GitHub's answer, not its write. */
export async function writePullRequestBody(
  pullRequest: PullRequestBody,
  what: string,
  splice: (body: string) => string,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await pullRequest.read();
    const body = splice(before);
    if (body === before)
      return console.log(`PR #${pullRequest.number}'s body already carries ${what}`);
    const replaced = await pullRequest.replace(body).then(
      () => true,
      (error: unknown) => {
        console.warn(`${error instanceof Error ? error.message : String(error)}; reading anew`);
        return false;
      },
    );
    if (!replaced) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    const after = await pullRequest.read();
    if (splice(after) === after)
      return console.log(`wrote ${what} into the body of PR #${pullRequest.number}`);
    console.warn(
      `PR #${pullRequest.number}'s body changed under the write (attempt ${attempt}); re-splicing`,
    );
  }
  throw new Error(`could not write ${what} into PR #${pullRequest.number}'s body in three rounds`);
}

// ── the PR body's sign-in links ───────────────────────────────────────────────────────────────

/** A `Sign in ↗` link (scripts/preview.ts `signInLinks`): the app's own sign-in
 *  (iterate/app-server.ts `/.auth/login`), landing at `landing` — a URL on the app's origin — and,
 *  with `loginHint`, naming whom the consent page pre-fills under "Sign in as someone else" for an
 *  admin (src/consent.ts). The admin still confirms it: the link is public, and grants nothing. */
export function appSignInLink(landing: string, loginHint?: string) {
  const url = new URL(landing);
  const query = new URLSearchParams({ next: `${url.pathname}${url.search}` });
  if (loginHint) query.set("login_hint", loginHint);
  return `${url.origin}/.auth/login?${query}`;
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
 *  One row per worker, apps/os first: its origin, its `Sign in ↗` (`appSignInLink`: apps/os's into
 *  the Dash's project `pr<N>`, each app's into that app, as the PR's test person, whom a reviewer —
 *  one of prd's admins, signed in through prd (src/admin-sign-in.ts) — confirms signing in as on
 *  the consent page; the admin app's as the reviewer) and its Cloudflare dashboard page. With the
 *  Dash, one quick-launch link per config template into its New project sheet
 *  (`templateQuickLaunches`). And, only when CI's seed of the test project failed, that fact: there
 *  is then nobody to sign in as. */
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
          `Seeding \`${input.seed.project}\` failed (the deploy log says why): there is nobody to sign in as yet.`,
        ]),
  ].join("\n");
}

/** A deploy bundles whatever node_modules holds, so an install older than pnpm-lock.yaml would ship
 *  stale dependencies. pnpm keeps the lockfile it installed from as node_modules/.pnpm/lock.yaml:
 *  the same bytes prove the install current, whatever the mtimes say. They say the wrong thing
 *  when a checkout after the install rewrites pnpm-lock.yaml with the same content, as checking out
 *  a PR's head and then the PR merged into main does. Only when the content differs does the laptop
 *  rule decide: a lockfile newer than node_modules/.modules.yaml means `pnpm install` has not run
 *  since it changed. */
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
