// scripts/preview-config.ts — the pure half of scripts/preview.ts, what preview.test.ts pins: the
// name of a run's per-commit deployment (`pr<n>-<sha7>`, or a slug's; envs.ts `previewDeployment`
// derives every worker, URL and resource from it), the PR body's managed section and its status
// line, the template quick-launch links, and whether node_modules was installed from the
// checkout's lockfile.
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

/** Whether another suite's job may still overwrite this suite's line: the two jobs write at once,
 *  each a read, a splice and a PATCH, and a PATCH made from a read that predates this line's write
 *  drops it. Once every other suite's line names this line's commit, their writes have landed and
 *  none can: so only the first of the two to finish waits to look again (scripts/preview.ts
 *  `writePullRequestBody`), never the one that decides the run's time to green. */
export function suiteLineMayBeOverwritten(body: string, status: PreviewSuiteStatus) {
  const commit = `on \`${status.commit.slice(0, 9)}\``;
  return SUITE_ORDER.some((suite) => {
    if (suite === status.suite) return false;
    const [begin, end] = suiteMarkers(suite);
    const from = body.indexOf(begin);
    const to = body.indexOf(end, from);
    return from < 0 || to < from || !body.slice(from, to).includes(commit);
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

/** The status line, the URL, the deployment, the apps on top deployed this run and, on a PR, the
 *  one-click `Sign in ↗` links (src/test-link.ts) — the heading's into the Dash (or the issuer's own
 *  page), each app's into that app, and with the Dash one per config template into its New project
 *  sheet; the operations (e2e, delete, the laptop commands) are the README's, linked, not spelled
 *  here a second time. */
export function renderPullRequestSection(input: {
  /** the deployment's name, `pr<n>-<sha7>` */
  deployment: string;
  status: PreviewStatus;
  url: string;
  /** the Worker version apps/os's `/version` names */
  versionId: string;
  dashboardUrl: string;
  apps: { name: string; url: string }[];
  /** Which commit the run deployed (scripts/ci/preview-tested-commit.ts). */
  testedCommit?: string;
  /** The test person's links (scripts/preview.ts `previewSignIn`): only with a PR number. */
  signIn?: {
    heading: string;
    /** app name → its link */
    apps: Record<string, string>;
    /** one per config template, into the Dash's New project sheet: only when the Dash was deployed */
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
    `### OS preview: \`${input.deployment}\``,
    "",
    statusBlock(input.status),
    "",
    `**${input.url}**${signIn ? ` · [Sign in ↗](${signIn.heading})` : ""} · version \`${input.versionId.slice(0, 8)}\` · [Cloudflare dashboard](${input.dashboardUrl}) · deleted once the next push's deployment is ready, or when this PR closes`,
    "",
    ...(input.testedCommit ? [`Deployed from ${input.testedCommit}.`, ""] : []),
    ...(input.apps.length > 0
      ? signIn
        ? [
            "| App on top, signed in against this deployment | | |",
            "| --- | --- | --- |",
            ...input.apps.map(
              (app) =>
                `| ${app.name} | ${app.url} | ${signIn.apps[app.name] ? `[Sign in ↗](${signIn.apps[app.name]})` : ""} |`,
            ),
          ]
        : [
            "| App on top, signed in against this deployment | |",
            "| --- | --- |",
            ...input.apps.map((app) => `| ${app.name} | ${app.url} |`),
          ]
      : ["No app on top was deployed in this run."]),
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
          `\`Sign in ↗\` signs you in as \`${signIn.email}\` with project \`${signIn.project}\`, no password and no Allow page: the link is signed for this deployment only and expires in 14 days; every push mints a fresh one.${signIn.seeded ? "" : ` Seeding \`${signIn.project}\` failed this run (the deploy log says why), so the apps ask for consent.`}`,
          "",
        ]
      : []),
    "Every push deploys a fresh set of workers, with data of its own. E2e, delete and the laptop commands: [apps/os/README.md](https://github.com/iterate/iterate/blob/main/apps/os/README.md).",
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
