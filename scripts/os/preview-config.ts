// scripts/os/preview-config.ts — the pure half of scripts/os/preview.ts, what preview.test.ts pins: the
// name of a run's per-commit deployment (`pr<n>-<sha7>`, or a slug's; envs.ts `previewDeployment`
// derives every worker, URL and resource from it), the PR body's managed section and its fold into
// a previous commit's (scripts/ci/pull-request-body.ts writes them), the sign-in and template
// quick-launch links, the fetch routes the sign-in seed sets for the proxied apps, what on the
// account is never a preview's, and whether node_modules was installed from the checkout's lockfile.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FetchRouteInput } from "iterate/api";
import { projectUrlOf, type IngressRouting } from "iterate/project-ingress";
import { ciReportsEnvs, osEnvs, previewDeployment, spaEnvs, telemetryEnvs } from "../../envs.ts";
import { agents } from "../../apps/agents/scripts/app.ts";
import { dash } from "../../apps/dash/scripts/app.ts";
import { docs } from "../../apps/docs/scripts/app.ts";
import { kit } from "../../apps/kit/scripts/app.ts";
import { notes } from "../../apps/notes/scripts/app.ts";
import { admin } from "../../apps/admin/scripts/app.ts";
import { voice } from "../../apps/voice/scripts/app.ts";
import { markedSection, replaceMarkedSection } from "../ci/markdown-annotator.ts";
import type { StartApp } from "../lib/start-app.ts";

/** MAIN ON THE DEV/PREVIEW ACCOUNT (envs.ts `osEnvs.preview`): the account every per-commit
 *  deployment lives on, whose Doppler config (`os/preview`) holds its Cloudflare credentials and
 *  the two secrets each core/os deploy ships. preview-parents.yml redeploys it from main. */
export const MAIN_ON_DEV = osEnvs.preview!;

/** The longest prefix a deployment name takes (envs.ts `previewDeployment`): every worker and
 *  resource name of the set stays under Cloudflare's 63 characters. */
export const MAX_PREVIEW_PREFIX_LENGTH = 28;

/** The apps on top, each deployed beside core/os as `<deployment>-<app>`. */
export const APPS: StartApp[] = [dash, agents, notes, docs, voice, kit, admin];

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

/** A deployment's core/os origin, and its apps' by name: envs.ts `previewDeployment`, for a name
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

/** envs.ts's workers on the dev/preview account: main on dev (`os`, each app's) and every other
 *  deployment there (the CI reports viewer, the SPA example, the telemetry receiver). The sweep
 *  never deletes one. */
export function accountWorkerNames() {
  return new Set(
    [osEnvs, ...APPS.map((app) => app.envs), spaEnvs, ciReportsEnvs, telemetryEnvs]
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

/** A deploy starts by folding the section it will replace into a `<details>` ("Previous commit's
 *  deployment"), so the links read as a previous commit's at a glance, and a deploy that fails
 *  leaves them folded; the next deploy that lands writes the section unfolded. A closed PR's delete
 *  folds it too ("Deleted deployment"), and nothing replaces it: its links are dead. Once change
 *  detection lands (tasks/ci-change-detection.md), fold only after it has decided to deploy: a push
 *  that reuses the deployment leaves it current. A body with no section, or one already folded,
 *  stays as it is. */
export function foldPreviewSection(
  body: string,
  label: "Previous commit's deployment" | "Deleted deployment",
) {
  const inner = markedSection(body, PREVIEW_SECTION);
  if (!inner || inner.startsWith("<details>")) return body;
  const heading = SECTION_HEADING.exec(inner);
  const summary = heading ? `${label}: <code>${heading[1]}</code>` : label;
  return replaceMarkedSection(
    body,
    PREVIEW_SECTION,
    `<details><summary>${summary}</summary>\n\n${heading ? inner.slice(heading[0].length) : inner}\n\n</details>`,
  );
}

// ── the PR body's sign-in links ───────────────────────────────────────────────────────────────

/** A `Sign in ↗` link (scripts/os/preview.ts `signInLinks`): the app's own sign-in
 *  (iterate/app-server.ts `/.auth/login`), landing at `landing` — a URL on the app's origin — with
 *  its `hints`: `provider_hint`, the way to sign in the platform's sign-in page leads with (the
 *  admin issuer, prd, for a reviewer: core/os/src/login.server.ts), and `login_hint`, whom the consent page
 *  pre-fills under "Sign in as someone else" for an admin (core/os/src/consent.ts). The admin still confirms
 *  it: the link is public, and grants nothing. */
export function appSignInLink(
  landing: string,
  hints: { provider_hint: string; login_hint?: string },
) {
  const url = new URL(landing);
  const query = new URLSearchParams({ next: `${url.pathname}${url.search}`, ...hints });
  return `${url.origin}/.auth/login?${query}`;
}

/** THE APPS SERVED THROUGH A PROJECT (apps/notes, apps/docs): no OAuth client, and no sign-in of
 *  their own. A project's config worker (the app's `config-worker.ts`), or the fetch route the seed
 *  sets (`proxiedAppRoute`), fetches the project's routing slug of the app's name through to the
 *  app's Worker, and the page runs on its host's sign-in: under paths ingress, every deployment's,
 *  the platform's own. */
export const PROXIED_APPS = new Set(["notes", "docs"]);

/** One app's `Sign in ↗` (scripts/os/preview.ts `signInLinks`), in the PR's test project `project`.
 *  A proxied app's lands on its page for the project,
 *  `<platform>/projects/<project>/<app>/projects/<project>`, through the platform's sign-in when
 *  signed out, where an admin signs in as themselves, a member of the project (the seed adds them).
 *  Its own page for the project, not its root: the root opens the person's first project, which for
 *  an admin may be another. The Dash's is its own sign-in into the project, naming the test person
 *  `email`; the admin app's names nobody (an admin opens it as themselves); every other app's is
 *  its own sign-in naming the test person (`appSignInLink`). Each suggests signing in through
 *  `providerHint`, the deployment's admin issuer's host. */
export function signInLinkOf(input: {
  app: { name: string; url: string };
  platform: string;
  ingressRouting: IngressRouting;
  project: string;
  email: string;
  providerHint: string;
}) {
  const { app, project, email } = input;
  const provider_hint = input.providerHint;
  if (PROXIED_APPS.has(app.name)) {
    const page = projectUrlOf(input.ingressRouting, input.platform, {
      project,
      routingSlug: app.name,
      path: `/projects/${project}`,
    });
    if (page?.origin !== new URL(input.platform).origin)
      throw new Error(
        `${app.name} in project ${project} is not a path on ${input.platform}: a proxied app's link needs paths ingress, where it runs on the platform's sign-in`,
      );
    // the platform's own sign-in for the app's host, which a signed-in member passes straight on
    return appSignInLink(page.href, { provider_hint });
  }
  if (app.name === "dash")
    return appSignInLink(`${app.url}/projects/${project}`, { provider_hint, login_hint: email });
  if (app.name === "admin") return appSignInLink(app.url, { provider_hint });
  return appSignInLink(app.url, { provider_hint, login_hint: email });
}

/** THE FETCH ROUTE the seed sets on the PR's test project for a proxied app the deployment has
 *  (scripts/os/preview.ts `seedSignIn`), so its `Sign in ↗` lands on the app: the routing slug of the
 *  app's name, members only, to a loaded worker that fetches through to `appUrl`, the deployment's
 *  own app Worker, as the app's `config-worker.ts` does for prd's. The project's config worker
 *  (configs/default/worker.ts) forwards a member's request to it, and answers anyone else the
 *  sign-in challenge. */
export function proxiedAppRoute(app: string, appUrl: string) {
  const { protocol, host } = new URL(appUrl);
  const worker = [
    "export default {",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    `    url.protocol = ${JSON.stringify(protocol)};`,
    `    url.host = ${JSON.stringify(host)};`,
    '    return fetch(new Request(url, new Request(request, { redirect: "manual" })));',
    "  },",
    "};",
    "",
  ].join("\n");
  return {
    requestMatcher: { routingSlug: app },
    target: [
      "itx",
      "workers",
      ["get", { source: { "package.json": '{"main":"worker.js"}', "worker.js": worker } }],
    ],
    authRequirement: { visitors: "project-members" },
  } satisfies FetchRouteInput;
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
 *  the custom field prefilled), so the project is born from the unmerged template. `default` never
 *  is: the preview embeds this PR's copy, its agents pinned to this PR's build (core/os/scripts/build.ts). */
export function templateQuickLaunches(input: {
  dashUrl: string;
  templates: string[];
  changedPaths: string[];
  headSha: string;
}) {
  return input.templates.map((name) => {
    const changed =
      name !== "default" && input.changedPaths.some((file) => file.startsWith(`configs/${name}/`));
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
 *  One row per worker, core/os first: its origin, its `Sign in ↗` (`signInLinkOf`: core/os's into
 *  the Dash's project `pr<N>`, each app's into that app, as the PR's test person, whom a reviewer —
 *  one of prd's admins, signed in through prd (core/os/src/admin-sign-in.ts) — confirms signing in as on
 *  the consent page; a proxied app's and the admin app's as the reviewer) and its Cloudflare
 *  dashboard page. With the
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
