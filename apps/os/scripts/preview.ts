// scripts/preview.ts — one Worker Preview per pull request of the one worker, the cloudflare-os recipe
// (their scripts/preview/preview.ts: eighteen workers in three tiers collapsed to one). The effects
// half; the pure half — naming, the PR body's section, the preview's wrangler config — is
// scripts/preview-config.ts (preview.test.ts). Commands: config (build and write preview config),
// deploy (build, the D1 migrated and the Artifacts namespace, the secrets, `wrangler preview`, the
// PR body and its status line), e2e and specs (the vitest e2e suite, `--slow-rows` picking the rows
// tagged `slow`, scripts/slow-rows.ts, or the Playwright specs, against the live preview; the
// suite's line, handed to the CI trace job), suite-lines (the CI trace job's: both suites' lines
// under the status line, in one write), reset (delete, then deploy), delete (the preview, its D1,
// Artifacts namespace, KV namespaces and R2 bucket, the apps on top), sweep (the stale previews, the
// old preview workers and the resources that outlived theirs — the rules are
// scripts/preview-sweep.ts), deploy-parents (the workers every preview branches from, from this
// checkout: preview-parents.yml on every push to main), reset-parent (the `os` parent's own data
// erased, then the parent deployed again: preview-sweep.yml, nightly). `--dry-run` prints the plan.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import { createCli } from "trpc-cli";
import { z } from "zod";
import {
  TestEvidenceTarget,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import { OS_DOPPLER_PROJECT, osEnvs, type OsEnv } from "../../../envs.ts";
import {
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  runAsync,
  smoke,
} from "../../../scripts/lib/deploy-helpers.ts";
import {
  CloudflareApiError,
  resolveEnvContext,
  type EnvContext,
} from "../../../scripts/lib/env-context.ts";
import {
  buildStartApp,
  writeStartAppPreviewConfig,
  type StartApp,
} from "../../../scripts/lib/start-app.ts";
import { awaitDeployOfThisRun } from "../../../scripts/ci/await-deploy.ts";
import { createOctokit, getOctokit, getRepo } from "../../../scripts/ci/github.ts";
import { getSlackClient, slackChannelIds } from "../../../scripts/ci/slack.ts";
import { traceOperation } from "../../../scripts/ci/tracing/tracing.ts";
import { parseAppConfig, type AppConfig } from "../src/app-config.ts";
import { TEST_EMAIL_DOMAIN } from "../src/test-email-domain.ts";
import { buildOs } from "./build.ts";
import { applyD1Migrations, ensureD1, findD1, type D1Row } from "./d1.ts";
import deployOs from "./deploy.ts";
import eraseData from "./erase-data.ts";
import { awaitPreviewReady } from "./preview-readiness.ts";
import {
  deleteArtifactsNamespace,
  ensureArtifactsNamespace,
  isCloudflareError,
  renderStuckArtifactsNamespacesPage,
  type ArtifactsNamespaceRow,
  type Cf,
  type StuckArtifactsNamespace,
} from "./preview-artifacts.ts";
import {
  accountResourceNames,
  accountWorkerNames,
  APPS,
  appPreviewOrigins,
  appPreviewUrl,
  appSignInLink,
  assertFreshInstall,
  changedApps,
  configTemplateNames,
  deployWithStatus,
  FORMER_PARENTS,
  lastLines,
  parseSuiteLineOutputs,
  PREVIEW_CONFIG_NAME,
  PREVIEW_PARENT,
  isDurableObjectClassNotExportedError,
  previewPullRequestNumber,
  previewResourceName,
  previewResourceSuffixes,
  previewUrl,
  renderPullRequestSection,
  resolvePreviewName,
  PREVIEW_SUITES,
  splicePreviewStatus,
  splicePullRequestBody,
  spliceSuiteLines,
  suiteLineOutput,
  templateQuickLaunches,
  writePreviewWranglerConfig,
  writePullRequestBody,
  type PreviewStatus,
  type PreviewSuite,
  type PreviewSuiteStatus,
  type PullRequestBody,
} from "./preview-config.ts";
import {
  groupPreviewDeployments,
  planPreviewSweep,
  previewNameOfSweptResource,
  renderWorkerlessNamespacesPage,
  workerlessNamespaces,
  type PullRequestState,
  type SweptNamespace,
  type SweptResource,
} from "./preview-sweep.ts";
import { chooseSlowRows, SlowRows, slowRowsTagsFilter } from "./slow-rows.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "../..");
const OUTPUT_DIR = path.join(ROOT, "output");
/** cloudflare-os runs on this draft build too: released wrangler accepts a binding-only KV entry in
 *  `previews` but sends `namespace_id: undefined`; the branch of workers-sdk PR #14416 provisions a
 *  fresh KV namespace and R2 bucket per preview. Its `preview delete` deletes them only when the
 *  config it reads declares them (binding-only `previews` entries), and the delete here hands it one
 *  naming the parent alone — so deletePreview deletes them itself (2026-09-23: 162 KV namespaces and
 *  81 R2 buckets had leaked). Drop this, and the tmpdir install below, once a released changelog
 *  mentions preview auto-provisioning. */
const WRANGLER_PACKAGE = "https://pkg.pr.new/wrangler@14416";

const Command = z.enum([
  "config",
  "deploy",
  "e2e",
  "specs",
  "reset",
  "delete",
  "sweep",
  "deploy-parents",
  "reset-parent",
  "suite-lines",
]);
type Command = z.infer<typeof Command>;
/** The apps on top: every one by default, none, or (auto) the ones whose paths this PR changes. */
const AppsMode = z.enum(["all", "auto", "none"]);
type AppsMode = z.infer<typeof AppsMode>;

/** The parent's Doppler config (envs.ts `OS_DOPPLER_PROJECT`, config `preview`), downloaded — the
 *  Cloudflare credentials for its account and the two secrets every preview inherits — the way
 *  ensure-resources and erase-data resolve theirs. Refuses a Doppler account that is not the
 *  parent's. */
const parentContext = () =>
  resolveEnvContext({ envs: osEnvs, dopplerProject: OS_DOPPLER_PROJECT, env: "preview" });

// ── process helpers (cloudflare-os) ────────────────────────────────────────────────────────────

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Run a command and capture its output — wrangler's `--json` payload, its prose for a not-found
 *  check. What may stream through runs by deploy-helpers' `runAsync`. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  console.log(
    `running${options.cwd ? ` in ${path.relative(ROOT, options.cwd) || "."}` : ""}: ${command} ${args.join(" ")}`,
  );
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || ROOT,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => (stdout += data));
      child.stderr.on("data", (data: string) => (stderr += data));
      child.once("error", (error) =>
        reject(new Error(`failed to run ${command}: ${error.message}`)),
      );
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}

/** The wrangler a run uses: the pinned draft build (WRANGLER_PACKAGE) installed into a tmpdir the
 *  way cloudflare-os does it (pnpm, exotic subdeps allowed for the pkg.pr.new workspace packages). */
function preparePreviewWrangler() {
  const installDir = mkdtempSync(path.join(tmpdir(), "os-preview-wrangler-"));
  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ private: true, dependencies: { wrangler: WRANGLER_PACKAGE } }),
  );
  writeFileSync(
    path.join(installDir, "pnpm-workspace.yaml"),
    "allowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\n",
  );
  return {
    command: path.join(installDir, "node_modules", ".bin", "wrangler"),
    ready: runAsync("pnpm", ["--config.blockExoticSubdeps=false", "--dir", installDir, "install"], {
      cwd: installDir,
    }),
    cleanup: () => rmSync(installDir, { recursive: true, force: true }),
  };
}

/** `wrangler --json` still logs prose ahead of the JSON object; the payload comes last. */
function parseWranglerJson(raw: string): {
  preview?: { id?: string; name?: string; slug?: string; urls?: string[] };
  deployment?: { id?: string; urls?: string[] };
} {
  const start = raw.lastIndexOf("\n{");
  const jsonStart = start >= 0 ? start + 1 : raw.indexOf("{");
  if (jsonStart < 0) throw new Error("wrangler emitted no JSON payload");
  return JSON.parse(raw.slice(jsonStart));
}

/** Every row of a paged account listing — D1, Artifacts namespaces and a worker's previews all page
 *  the same way (`per_page`, `page`; the previews list hands out ten a page unless asked, measured). */
async function listAll<T>(cf: Cf, route: string) {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await cf<T[]>(`${route}?per_page=100&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

// ── GitHub (scripts/ci/github.ts: a 5xx on a read or a whole-body write is asked again) ─────────

/** The pull request `number` of this repository (GITHUB_REPOSITORY), as Octokit's parameters. */
const pullRequest = (number: string | number) => ({ ...getRepo(), pull_number: Number(number) });

/** The PR's body on GitHub, read and replaced (preview-config.ts `writePullRequestBody`). */
function pullRequestBody(prNumber: string): PullRequestBody {
  const github = getOctokit();
  return {
    number: prNumber,
    read: async () => (await github.rest.pulls.get(pullRequest(prNumber))).data.body || "",
    replace: async (body) => {
      await github.rest.pulls.update({
        ...pullRequest(prNumber),
        body,
        request: { askOnce: true },
      });
    },
  };
}

/** The commit this checkout is: the one the job deployed or tested (the PR merged into main in CI). */
function checkedOutCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Where the preview stands, as the PR body's status line (preview-config.ts `PreviewStatus`):
 *  this checkout's commit, this CI job (`DEPOT_JOB_URL`), now. Only with a PR and a token; a write
 *  that fails is logged, never the job's failure — the job's own outcome stands. */
async function writeStatus(
  prNumber: string | undefined,
  status: Pick<PreviewStatus, "state" | "error">,
) {
  if (!prNumber || !process.env.GITHUB_TOKEN) return;
  const what = `the preview status (${status.state})`;
  const stamp = { commit: checkedOutCommit(), runUrl: process.env.DEPOT_JOB_URL, at: new Date() };
  await writePullRequestBody(pullRequestBody(prNumber), what, (body) =>
    splicePreviewStatus(body, { ...status, ...stamp }),
  ).catch((error: unknown) => console.warn(`could not write ${what}: ${describe(error)}`));
}

/** A suite's line (preview-config.ts `PreviewSuiteStatus`) for the PR body, stamped like the status
 *  line, handed to the CI trace job as this job's `status` output (preview-os.yml): the suite writes
 *  nothing to GitHub itself, so its check waits on no PR body write. Only in CI (`GITHUB_OUTPUT`)
 *  and with a PR. */
function handOverSuiteLine(
  prNumber: string | undefined,
  status: Pick<PreviewSuiteStatus, "suite" | "state" | "error">,
) {
  if (!prNumber || !process.env.GITHUB_OUTPUT) return;
  const stamp = { commit: checkedOutCommit(), runUrl: process.env.DEPOT_JOB_URL, at: new Date() };
  appendFileSync(process.env.GITHUB_OUTPUT, `status=${suiteLineOutput({ ...status, ...stamp })}\n`);
  console.log(`handed the ${PREVIEW_SUITES[status.suite]} line (${status.state}) to the CI trace`);
}

/** THE SUITES' LINES, the CI trace job's one write after both suites (preview-os.yml): the lines
 *  their jobs handed over (`handOverSuiteLine`), one a line in `outputs`, each in its place under
 *  the status line. A suite that handed over none keeps the line the body has. Like the status
 *  line, a write that fails is a warning, never the job's failure. */
async function writeSuiteLines(prNumber: string | undefined, outputs: string) {
  const statuses = parseSuiteLineOutputs(outputs);
  if (!prNumber || !process.env.GITHUB_TOKEN || statuses.length === 0)
    return console.log("no suite line to write: no PR, no token, or no suite handed one over");
  const lines = statuses.map((status) => `${PREVIEW_SUITES[status.suite]} ${status.state}`);
  const what = `the suites' lines (${lines.join(", ")})`;
  await writePullRequestBody(pullRequestBody(prNumber), what, (body) =>
    spliceSuiteLines(body, statuses),
  ).catch((error: unknown) =>
    console.log(`::warning title=PR body not updated::could not write ${what}: ${describe(error)}`),
  );
}

// ── the control plane's D1 (scripts/d1.ts): created and migrated by the deploy, deleted here ────

/** The preview's D1, created when missing and migrated, before any code that reads it deploys. It
 *  is created near this job (`automatic`, scripts/d1.ts `D1Location`). */
async function ensurePreviewDatabase(ctx: EnvContext<OsEnv>, previewName: string) {
  const databaseName = previewResourceName(previewName, "db");
  const { uuid } = await ensureD1(ctx.cf, databaseName, "automatic");
  await applyD1Migrations(ctx.cf, {
    databaseName,
    databaseId: uuid,
    credentials: {
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN!,
      CLOUDFLARE_ACCOUNT_ID: PREVIEW_PARENT.cloudflareAccountId,
    },
  });
  return uuid;
}

async function deleteDatabase(cf: Cf, name: string) {
  const row = await findD1(cf, name);
  if (!row) return console.warn(`D1 ${name} did not exist; continuing.`);
  await cf(`/d1/database/${row.uuid}`, { method: "DELETE" });
  console.log(`deleted D1 ${name}`);
}

// ── the Artifacts namespace: scripts/preview-artifacts.ts ───────────────────────────────────────

// ── the KV namespaces and the R2 bucket (provisioned by `wrangler preview`, deleted here) ──────

type KvNamespaceRow = { id: string; title: string };

/** One already gone — the sweep racing the close job, a re-run — is deleted. */
async function deleteKvNamespace(cf: Cf, row: KvNamespaceRow) {
  await cf(`/storage/kv/namespaces/${row.id}`, { method: "DELETE" }).catch((error) => {
    if (!isCloudflareError(error, 404, 10013)) throw error;
  });
  console.log(`deleted KV namespace ${row.title}`);
}

/** Delete an R2 bucket: its objects first (the API refuses a bucket that still holds any), then the
 *  bucket. The first thousand-key page is read again until it is empty, twenty deletes in flight —
 *  a preview's e2e run leaves tens, the soak preview's bucket held 1,908 (measured 2026-09-23) — and
 *  a ceiling keeps that bounded. A bucket that does not exist is the expected case. */
async function deleteR2Bucket(cf: Cf, bucketName: string) {
  const route = `/r2/buckets/${bucketName}`;
  let deletedObjects = 0;
  for (let round = 1; ; round++) {
    if (round > 50)
      throw new Error(
        `R2 bucket ${bucketName} still holds objects after ${deletedObjects} deletes`,
      );
    const objects = await cf<{ key: string }[]>(`${route}/objects?per_page=1000`).catch((error) => {
      if (isCloudflareError(error, 404, 10006)) return undefined;
      throw error;
    });
    if (!objects) return console.warn(`R2 bucket ${bucketName} did not exist; continuing.`);
    if (objects.length === 0) break;
    for (let i = 0; i < objects.length; i += 20) {
      await Promise.all(
        objects.slice(i, i + 20).map(({ key }) =>
          // a key's slashes are its path: each segment encoded, the slashes kept
          cf(`${route}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
            method: "DELETE",
          }).catch((error) => {
            // one already gone (a racing delete took it, or the whole bucket) is deleted
            if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
          }),
        ),
      );
    }
    deletedObjects += objects.length;
  }
  await cf(route, { method: "DELETE" }).catch((error) => {
    if (!isCloudflareError(error, 404, 10006)) throw error;
  });
  console.log(`deleted R2 bucket ${bucketName} (${deletedObjects} objects)`);
}

/** A worker, and with `force` every Durable Object namespace of it: Cloudflare's "any of these
 *  associated bindings/durable objects will be deleted along with the script". One already gone is
 *  deleted. */
async function deleteWorker(cf: Cf, name: string) {
  await cf(`/workers/scripts/${name}?force=true`, { method: "DELETE" }).catch((error) => {
    if (!isCloudflareError(error, 404, 10007)) throw error;
  });
  console.log(`deleted worker ${name}`);
}

// ── the apps on top (cloudflare-os's second tier) ──────────────────────────────────────────────

const isMissingWorkerError = (output: string) =>
  /This Worker does not exist on your account|code"?:\s*10007/i.test(output);

/** A config that names a parent worker and nothing else: enough for `wrangler preview delete`
 *  and the sweep, on a checkout that never built anything. */
function writeParentConfig(parent: { workerName: string; cloudflareAccountId: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "os-preview-parent-"));
  const file = path.join(dir, "wrangler.json");
  writeFileSync(
    file,
    JSON.stringify({ name: parent.workerName, account_id: parent.cloudflareAccountId }),
  );
  return file;
}

/** Write the app's preview config — this PR's apps/os preview as the issuer, this run's app
 *  previews as the other apps (`appPreviewOrigins`) — onto its `preview` build, and branch a
 *  preview off the app's parent, which main deploys (deployParents). */
async function deployAppPreview(
  app: StartApp,
  previewName: string,
  input: { issuer: string; appOrigins: Record<string, string> },
  wrangler: string,
) {
  const root = path.resolve(import.meta.dirname, "../..", app.name);
  const config = writeStartAppPreviewConfig(app, input);
  const result = await run(wrangler, ["preview", "--name", previewName, "-c", config, "--json"], {
    cwd: root,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    const hint = isMissingWorkerError(output)
      ? ` — the parent worker ${app.envs.preview!.workerName} is missing: ${DEPLOY_PARENTS_HINT}`
      : "";
    throw new Error(
      `wrangler preview failed with exit code ${result.status}${hint}\n${lastLines(output, 40)}`,
    );
  }
  const url = parseWranglerJson(result.stdout).preview?.urls?.[0];
  if (url !== appPreviewUrl(app, previewName))
    throw new Error(`expected ${appPreviewUrl(app, previewName)}, wrangler returned ${url}`);
  await smoke(`${url}/healthz`, (status) => status === 200, `apps/${app.name} health`);
  return { name: app.name, url };
}

/** The apps this run previews: --apps all, none, or (auto) the ones whose paths this PR changes. */
async function appsToPreview(mode: AppsMode, prNumber: string | undefined) {
  if (mode === "all") return APPS;
  if (mode === "none") return [];
  try {
    const apps = changedApps(await changedPaths(prNumber));
    console.log(`apps on top changed: ${apps.map((app) => app.name).join(", ") || "none"}`);
    return apps;
  } catch (error) {
    console.warn(`${describe(error)}; previewing every app on top.`);
    return APPS;
  }
}

/** The paths this pull request changes. From GitHub when there is a PR — the same cumulative diff
 *  the PR page shows, and independent of how deep CI's checkout is (a depth-1 checkout has no
 *  merge-base); from git against origin/main on a laptop. */
async function changedPaths(prNumber: string | undefined) {
  if (prNumber && process.env.GITHUB_TOKEN) {
    const github = getOctokit();
    const files = await github.paginate(github.rest.pulls.listFiles, {
      ...pullRequest(prNumber),
      per_page: 100,
    });
    return files.map((file) => file.filename);
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  git("fetch", "--quiet", "origin", "main");
  return git("diff", "--name-only", git("merge-base", "origin/main", "HEAD"), "HEAD")
    .split("\n")
    .filter(Boolean);
}

/** `wrangler preview delete` of one preview of `parent` — apps/os's or an app's. One that never
 *  existed — a PR closed before its first deploy, a re-run of the cleanup job, the sweep racing the
 *  close job, a parent never deployed — is the expected case, not a failure. */
async function deleteWorkerPreview(
  parent: { workerName: string; cloudflareAccountId: string },
  previewName: string,
  wrangler: string,
) {
  const config = writeParentConfig(parent);
  try {
    const result = await run(wrangler, [
      "preview",
      "delete",
      "--name",
      previewName,
      "-c",
      config,
      "-y",
    ]);
    if (result.status === 0)
      return console.log(`${parent.workerName}: deleted preview ${previewName}`);
    if (/not found|does not exist|10007|10025|10222/i.test(`${result.stdout}\n${result.stderr}`))
      return console.warn(
        `${parent.workerName}: preview ${previewName} did not exist; continuing.`,
      );
    throw new Error(
      `${parent.workerName}: wrangler preview delete failed with exit code ${result.status}\n${result.stderr}`,
    );
  } finally {
    rmSync(path.dirname(config), { recursive: true, force: true });
  }
}

// ── the parents (preview-parents.yml) ───────────────────────────────────────────────────

/** How a missing or out-of-date parent is put right: every parent is main's. */
const DEPLOY_PARENTS_HINT =
  "deploy the parents from main (the Preview parents workflow, or `pnpm preview deploy-parents` in apps/os under Doppler os/preview)";

/** THE PARENTS, from this checkout: apps/os's `os` (envs.ts osEnvs.preview) as any OS deployment
 *  deploys (scripts/deploy.ts: its own resources, its Doppler secrets, its smokes), and each app's
 *  from its `preview` build, which signs in against `os` and links to the other parents
 *  (start-app.ts startAppWorkerConfig). Every preview branches from these; preview-parents.yml
 *  runs this on every push to main, so the parents are main on the dev/preview account. Side by
 *  side; every one settles before the failed ones are named. */
async function deployParents(ctx: EnvContext<OsEnv>) {
  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN!,
    CLOUDFLARE_ACCOUNT_ID: PREVIEW_PARENT.cloudflareAccountId,
  };
  const deployApp = async (app: StartApp) => {
    const root = path.resolve(import.meta.dirname, "../..", app.name);
    await buildStartApp(app, "preview");
    const builtConfig = findBuiltWranglerConfig(root);
    await deployWithSecrets({ cwd: root, builtConfig, secretValues: {}, credentials });
    await smoke(`${app.envs.preview!.baseUrl}/healthz`, (status) => status === 200, "health");
  };
  const steps = [
    { name: "apps/os", deploy: () => deployOs({ env: "preview" }) },
    ...APPS.map((app) => ({ name: `apps/${app.name}`, deploy: () => deployApp(app) })),
  ];
  const results = await Promise.allSettled(steps.map((step) => step.deploy()));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [`${steps[index]!.name}: ${describe(result.reason)}`] : [],
  );
  if (failures.length) throw new Error(`parents failed\n\n${failures.join("\n\n")}`);
  console.log(
    `✅ parents deployed: ${[PREVIEW_PARENT, ...APPS.map((app) => app.envs.preview!)].map((env) => env.baseUrl).join(", ")}`,
  );
}

/** THE NIGHTLY RESET of the `os` parent's own data (preview-sweep.yml): what people and agents left
 *  on os.iterate-dev-preview.workers.dev and the app parents signed in against it — its Durable
 *  Objects, its D1's rows (users, organizations, projects), KV, R2 and Artifacts repos — erased
 *  (scripts/erase-data.ts), then the parent deployed again from this checkout. Its Worker Previews
 *  keep their own data and keep serving throughout: the retirement tombstones the parent's own
 *  namespaces only, and the parked parent keeps preview URLs on (scripts/lib/do-reset.ts; both
 *  measured 2026-09-24 on a throwaway worker). The app parents hold nothing worth a reset: a
 *  browser session each, which the next sign-in replaces. */
async function resetParent(options: { dryRun: boolean }) {
  await eraseData({ env: "preview", dryRun: options.dryRun });
  if (options.dryRun) return;
  await deployOs({ env: "preview" });
}

// ── the preview itself ─────────────────────────────────────────────────────────────────────────

/** `preview secret bulk` writes the WORKER's Previews settings, which every preview of it inherits:
 *  one upload covers every preview, and each run refreshes them. The two secrets are the deployment's
 *  (src/app-config.ts, scripts/deploy.ts ships the same two): the one `APP_CONFIG` object —
 *  `login.password`, `secrets.adminBearer` — and `APP_CONFIG_SECRETS__KEY` beside it. Values go
 *  through a 0600 tmp file, never argv or the config. The command reads only the worker's name and
 *  account, so the config naming the parent alone serves, and the upload needs no build: it runs
 *  beside the builds, in its own directory, away from the dist/ they write. */
async function uploadPreviewSecrets(wrangler: string, ctx: EnvContext<OsEnv>) {
  const secrets = collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]);
  const config = writeParentConfig(PREVIEW_PARENT);
  const dir = path.dirname(config);
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    await runAsync(wrangler, ["preview", "secret", "bulk", file, "-c", config], { cwd: dir });
    console.log(
      `uploaded ${Object.keys(secrets).length} secrets to the Previews settings of ${PREVIEW_PARENT.workerName}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The OS's own preview, from an OS build already made, its D1 (`databaseId`, migrated), its
 *  Artifacts namespace and the Previews secrets already in place: its config (naming the PR's Dash
 *  preview when this run deploys one), `wrangler preview`, and the readiness gate on the new
 *  deployment. */
async function deployOsPreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  databaseId: string,
  dashOrigin: string | undefined,
  wrangler: string,
  recreated = false,
): Promise<{ url: string; deploymentId: string; slug: string }> {
  writePreviewWranglerConfig({ previewName, databaseId, dashOrigin });
  const result = await run(wrangler, [
    "preview",
    "--name",
    previewName,
    "-c",
    PREVIEW_CONFIG_NAME,
    "--json",
  ]);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    // An existing preview cannot gain a Durable Object class (preview-config.ts): delete it with
    // its resources and create it again, once. The apps on top deploying beside it are previews of
    // their own parents, and stay.
    if (!recreated && isDurableObjectClassNotExportedError(output)) {
      console.warn(
        `preview ${previewName} lacks a Durable Object class this build binds (Cloudflare 10061), and an existing Worker Preview cannot gain one: deleting the preview and its resources, then creating it again`,
      );
      await deletePreview(ctx.cf, previewName, wrangler);
      const [recreatedDatabaseId] = await Promise.all([
        ensurePreviewDatabase(ctx, previewName),
        ensureArtifactsNamespace(ctx.cf, previewResourceName(previewName, "repos")),
      ]);
      return deployOsPreview(ctx, previewName, recreatedDatabaseId, dashOrigin, wrangler, true);
    }
    // Not the parent's classes: a brand-new preview binds a class its parent never had (measured
    // 2026-09-24 on a throwaway worker).
    const hint = isMissingWorkerError(output)
      ? ` — the parent worker ${PREVIEW_PARENT.workerName} is missing: ${DEPLOY_PARENTS_HINT}`
      : "";
    throw new Error(
      `wrangler preview failed with exit code ${result.status}${hint}\n${lastLines(output, 40)}`,
    );
  }
  const data = parseWranglerJson(result.stdout);
  const url = data.preview?.urls?.[0];
  const deploymentId = data.deployment?.id;
  if (!url || !deploymentId)
    throw new Error(`wrangler emitted no preview URL or deployment id:\n${result.stdout}`);
  if (url !== previewUrl(previewName)) {
    throw new Error(
      `expected preview URL ${previewUrl(previewName)}, but wrangler returned ${url}`,
    );
  }
  // apps/os's smoke is the readiness gate (preview-readiness.ts), asked as soon as `wrangler
  // preview` returns. Nothing is handed on — the PR body's links, the sign-in seed, the e2e job —
  // until three rounds of eight in a row answer in full on this deployment. A preview that misses
  // the gate's deadline fails the deploy.
  await traceOperation("Readiness gate", () =>
    awaitPreviewReady(url, {
      adminSecret: parseAppConfig(
        collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]),
      ).secrets.adminBearer.exposeSecret(),
      version: deploymentId,
      width: 8,
      consecutive: 3,
    }),
  );
  return { url, deploymentId, slug: data.preview?.slug || previewName };
}

/** The status line says `deploying` first and `deploy failed`, with the error's tail, when any
 *  step throws; a deploy that lands rewrites the whole section, `deployed`. The `deploying` write
 *  runs beside the steps, and both later writes land after it (preview-config.ts
 *  `deployWithStatus`). */
async function deployPreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  await deployWithStatus(
    (status) =>
      traceOperation(`Write the ${status.state} status`, () =>
        writeStatus(
          prNumber,
          status.state === "deploying"
            ? status
            : { state: status.state, error: describe(status.error) },
        ),
      ),
    (deploying) => deployPreviewSteps(ctx, previewName, prNumber, apps, deploying),
  );
}

/** Wait for every promise, then throw the first failure: a step that fails early leaves none still
 *  running when the deploy reports it, nor the wrangler install they run removed under them. */
async function settleAll(promises: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(promises)).find(
    (result) => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

/** Each step starts once what it needs is there, and each is a span in the CI trace
 *  (docs/ci-traces.md): the wrangler install, the Previews secrets, the D1 and its migrations and
 *  the Artifacts namespace need no build and run beside the builds; apps/os deploys once its build and those are done, and
 *  each app on top once its own build and the wrangler are, beside apps/os — every URL is known
 *  before anything deploys (preview-config.ts `previewUrl`, `appPreviewUrl`). Every step settles
 *  before a failed one fails the deploy, named. Once apps/os's readiness gate has passed, the
 *  sign-in seed and the PR body's section go out side by side. */
async function deployPreviewSteps(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
  deploying: Promise<void>,
) {
  assertFreshInstall(REPO_ROOT);
  const appOrigins = appPreviewOrigins(apps, previewName);
  // the paths this PR changes, for the Dash's template links (signInLinks), read beside the builds
  const changed =
    prNumber && apps.some((app) => app.name === "dash")
      ? changedPaths(prNumber).catch((error: unknown) => {
          console.warn(
            `sign-in: ${describe(error)}; every template link names the preview's own copy`,
          );
          return [];
        })
      : Promise.resolve([]);
  const wrangler = preparePreviewWrangler();
  try {
    const installed = traceOperation("Install wrangler", () => wrangler.ready);
    const database = traceOperation("Ensure the D1 and apply its migrations", () =>
      ensurePreviewDatabase(ctx, previewName),
    );
    const prepared = settleAll([
      installed.then(() =>
        traceOperation("Upload the Previews secrets", () =>
          uploadPreviewSecrets(wrangler.command, ctx),
        ),
      ),
      database,
      traceOperation("Ensure the Artifacts namespace", () =>
        ensureArtifactsNamespace(ctx.cf, previewResourceName(previewName, "repos")),
      ),
    ]);
    const osPreview = (async () => {
      await settleAll([traceOperation("Build OS", () => buildOs("preview")), prepared]);
      const databaseId = await database;
      return traceOperation("Deploy OS preview", () =>
        deployOsPreview(ctx, previewName, databaseId, appOrigins.dash, wrangler.command),
      );
    })();
    const appPreviews = apps.map(async (app) => {
      await settleAll([
        traceOperation(`Build ${app.name}`, () => buildStartApp(app, "preview")),
        installed,
      ]);
      return traceOperation(`Deploy ${app.name}`, () =>
        deployAppPreview(
          app,
          previewName,
          { issuer: previewUrl(previewName), appOrigins },
          wrangler.command,
        ),
      );
    });
    const failures = (await Promise.allSettled([osPreview, ...appPreviews])).flatMap(
      (result, index) =>
        result.status === "rejected"
          ? [
              {
                step: index === 0 ? "apps/os" : `apps/${apps[index - 1]!.name}`,
                error: describe(result.reason),
              },
            ]
          : [],
    );
    // the failed steps on the first line (the PR body's summary), each one's error and output tail after it
    if (failures.length === 1) throw new Error(`${failures[0]!.step}: ${failures[0]!.error}`);
    if (failures.length > 1)
      throw new Error(
        `${failures.map(({ step }) => step).join(", ")} failed\n\n${failures.map(({ step, error }) => `${step}: ${error}`).join("\n\n")}`,
      );
    const { url, deploymentId, slug } = await osPreview;
    const deployedApps = await Promise.all(appPreviews);
    console.log(`\npreview ${previewName}: ${url}`);
    const config = parseAppConfig(collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]));
    const signIn = prNumber
      ? signInLinks({ url, prNumber, apps: deployedApps, changedPaths: await changed })
      : undefined;
    const publish = async (seeded: boolean) => {
      const summary = {
        previewName,
        status: {
          state: "deployed",
          commit: checkedOutCommit(),
          runUrl: process.env.DEPOT_JOB_URL,
          at: new Date(),
        } satisfies PreviewStatus,
        url,
        deploymentId,
        slug,
        dashboardUrl: `https://dash.cloudflare.com/${PREVIEW_PARENT.cloudflareAccountId}/workers/services/view/${PREVIEW_PARENT.workerName}/production/previews/${slug}`,
        apps: deployedApps,
        // the workflow's scripts/ci/preview-tested-commit.ts: the PR merged into main, or the head alone
        testedCommit: process.env.PREVIEW_TESTED_COMMIT,
        signIn: signIn && { ...signIn, seeded },
      };
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(path.join(OUTPUT_DIR, "preview.json"), `${JSON.stringify(summary, null, 2)}\n`);
      if (!prNumber || !process.env.GITHUB_TOKEN) return;
      await deploying;
      const section = renderPullRequestSection(summary);
      await traceOperation("Write the PR section", () =>
        writePullRequestBody(pullRequestBody(prNumber), "the preview section", (body) =>
          splicePullRequestBody(body, section),
        ),
      );
    };
    // The seed and the section side by side: a seed that failed rewrites the section to say so.
    const [seeded] = await Promise.all([
      signIn ? traceOperation("Seed sign-in", () => seedSignIn(config, { url, ...signIn })) : true,
      publish(true),
    ]);
    if (!seeded) await publish(false);
  } finally {
    wrangler.cleanup();
  }
}

/** THE SIGN-IN a PR's body links (preview-config.ts `appSignInLink`): the heading's link, one per
 *  app, and with the Dash one per config template into its New project sheet (preview-config.ts
 *  `templateQuickLaunches`), each the app's own sign-in naming the PR's test person
 *  `pr<N>@preview.iterate.test`, whose project `pr<N>` seedSignIn creates. The link is public and
 *  grants nothing: a reviewer signs in to the preview as themselves, one of prd's admins
 *  (src/admin-sign-in.ts), and confirms signing the app in as the test person on the consent page,
 *  which the link pre-fills (src/consent.ts). The admin app's names nobody: an admin opens it as
 *  themselves. The heading's lands in the Dash's `/projects/pr<N>` when the Dash was previewed,
 *  else on the issuer's own sign-in page. */
function signInLinks(preview: {
  url: string;
  prNumber: string;
  apps: { name: string; url: string }[];
  changedPaths: string[];
}) {
  const project = `pr${preview.prNumber}`;
  const email = `${project}@${TEST_EMAIL_DOMAIN}`;
  const link = (app: { name: string; url: string }) =>
    appSignInLink(
      app.name === "dash" ? `${app.url}/projects/${project}` : app.url,
      app.name === "admin" ? undefined : email,
    );
  const dash = preview.apps.find((app) => app.name === "dash");
  return {
    heading: dash ? link(dash) : `${preview.url}/login`,
    apps: Object.fromEntries(preview.apps.map((app) => [app.name, link(app)])),
    templates: dash
      ? templateQuickLaunches({
          dashUrl: dash.url,
          templates: configTemplateNames(REPO_ROOT),
          changedPaths: preview.changedPaths,
          // the PR head (the workflow's), which GitHub keeps; a laptop's checkout is its head
          headSha: process.env.PREVIEW_HEAD_SHA || checkedOutCommit(),
        }).map(({ name, fromHead, next }) => ({
          name,
          fromHead,
          link: appSignInLink(next, email),
        }))
      : [],
    email,
    project,
  };
}

/** Seed the PR's test person and project — created as them through the operator's bearer (`as`),
 *  the same idempotent call as e2e/support/project-host.ts `registerProject`, so the Dash link
 *  lands inside it. It never fails the deploy: it logs, and the section says when it failed. */
async function seedSignIn(
  config: AppConfig,
  preview: { url: string; email: string; project: string },
) {
  const { email, project } = preview;
  try {
    const socketUrl = new URL("/api", preview.url);
    socketUrl.protocol = "wss:";
    const socket = new WebSocket(socketUrl);
    // Undici implements the WebSocket transport; Workers' ambient type has extra unrelated members.
    // The one call it makes, typed here: `iterate/api`'s types need the worker's lib, which
    // tsconfig.scripts.json does not load.
    using rpc = newWebSocketRpcSession<{
      authenticate(credentials: { type: "admin-secret"; secret: string; as: { email: string } }): {
        projects: { create(input: { project: string }): Promise<unknown> };
      };
    }>(socket as unknown as globalThis.WebSocket);
    try {
      await rpc
        .authenticate({
          type: "admin-secret",
          secret: config.secrets.adminBearer.exposeSecret(),
          as: { email },
        })
        .projects.create({ project });
    } finally {
      socket.close();
    }
    console.log(`sign-in: seeded ${email} with project ${project}`);
    return true;
  } catch (error) {
    console.warn(`sign-in: seeding ${email} with project ${project} failed: ${describe(error)}`);
    return false;
  }
}

/** The preview, then everything it owned, each found by its name: its D1 and its Artifacts
 *  namespace (this script created them), its KV namespaces and its R2 bucket (wrangler provisioned them; see WRANGLER_PACKAGE
 *  for why its delete leaves them). One already gone is the expected case. Resolves to its
 *  Artifacts namespace when Cloudflare will not delete it (StuckArtifactsNamespace): the rest still
 *  goes, and the namespace, now an orphan, is the nightly sweep's to retry and page. */
async function deletePreview(cf: Cf, previewName: string, wrangler: string) {
  await deleteWorkerPreview(PREVIEW_PARENT, previewName, wrangler);
  await deleteDatabase(cf, previewResourceName(previewName, "db"));
  const stuck = await deleteArtifactsNamespace(cf, previewResourceName(previewName, "repos"));
  const suffixes = previewResourceSuffixes();
  const kvNamespaces = await listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces");
  for (const title of suffixes.kv.map((suffix) => previewResourceName(previewName, suffix))) {
    const row = kvNamespaces.find((namespace) => namespace.title === title);
    if (row) await deleteKvNamespace(cf, row);
    else console.warn(`KV namespace ${title} did not exist; continuing.`);
  }
  for (const suffix of suffixes.r2)
    await deleteR2Bucket(cf, previewResourceName(previewName, suffix));
  return stuck;
}

/** apps/os's preview and everything it owned, then every app on top's preview (whether or not it
 *  exists). A namespace Cloudflare will not delete does not fail it: the PR-close delete and main's
 *  e2e cleanup report on a commit that did not cause it, and the nightly sweep pages it. */
async function deleteAll(cf: Cf, previewName: string) {
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    const stuck = await deletePreview(cf, previewName, wrangler.command);
    for (const app of APPS)
      await deleteWorkerPreview(app.envs.preview!, previewName, wrangler.command);
    if (stuck)
      console.warn(
        `Artifacts namespace ${stuck.namespace} stays: Cloudflare will not delete it; the nightly sweep retries and pages #error-pulse.`,
      );
  } finally {
    wrangler.cleanup();
  }
}

/** Each suite's test telemetry identity, pinned rather than read from pnpm's ambient package name:
 *  the workspace is what its job's CI finalizer (`upload-test-telemetry.ts --flake-suites specs`
 *  or `preview-e2e`, which expects that one workspace) and scripts/ci/flake-suite-summary.ts match
 *  the suite by, and each suite records its flake lines into its own `flake-records-<suite>`
 *  directory (relative to GITHUB_WORKSPACE). Only when the workflow asks for telemetry
 *  (TEST_TELEMETRY_ARTIFACT_DIR): a run from a laptop records nothing. */
const PREVIEW_SUITE_TELEMETRY: Record<"specs" | "preview-e2e", Record<string, string>> = process.env
  .TEST_TELEMETRY_ARTIFACT_DIR
  ? {
      specs: {
        TEST_TELEMETRY_WORKSPACE: "iterate-root",
        FLAKE_RECORD_DIR: `${testEvidencePaths.flakeRecords}/specs`,
      },
      "preview-e2e": {
        TEST_TELEMETRY_WORKSPACE: "os",
        TEST_TELEMETRY_KIND: "e2e",
        TEST_TELEMETRY_SUITE: "vitest",
        FLAKE_RECORD_DIR: `${testEvidencePaths.flakeRecords}/preview-e2e`,
      },
    }
  : { specs: {}, "preview-e2e": {} };

/** THE DEPLOYED TARGET, in the test evidence folder before the suite starts, when the workflow
 *  records evidence (TEST_TELEMETRY_ARTIFACT_DIR): the preview and the deployment its `/version`
 *  answers with. A run against a preview deployed earlier (a dispatch of `test`, `e2e` or `specs`)
 *  tests what that deploy left, not the commit this job checked out
 *  (docs/test-evidence.md#when-deploy-e2e-and-specs-are-separate-jobs). It never fails the run: a
 *  preview that does not answer fails the suites, and the file then has no deploymentId. */
async function writeDeployedTarget(previewName: string, apps: TestEvidenceTarget["apps"]) {
  if (!process.env.TEST_TELEMETRY_ARTIFACT_DIR) return;
  const url = previewUrl(previewName);
  // `<deployId> <platformOrigin>` (src/worker.ts)
  const deploymentId = await fetch(`${url}/version`, { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => (response.ok ? (await response.text()).split(" ")[0] : undefined))
    .catch(() => undefined);
  try {
    const target = TestEvidenceTarget.parse({
      previewName,
      url,
      deploymentId: deploymentId?.trim() || undefined,
      apps,
      checkedAt: new Date().toISOString(),
    });
    const file = path.join(REPO_ROOT, testEvidencePaths.target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`);
  } catch (error) {
    console.warn(`the deployed target was not recorded: ${describe(error)}`);
  }
}

/** THE PROOF, one suite per CI job (preview-os.yml's E2E tests and Browser specs), against the
 *  live preview in deployed-target mode: `e2e`, the vitest e2e suite, and `specs`, the root
 *  Playwright specs (specs/AGENTS.md) — the suites `pnpm e2e` and `pnpm spec` run. Each runner
 *  derives the deployed target itself (e2e/support/deployed-target.ts, from the `APP_CONFIG` in this
 *  process's environment and the parent's envs.ts entry): the vitest suite in its global-setup, the
 *  specs in specs/setup.ts. Every spec project runs, the notes and voice projects against this
 *  preview's Notes, Voice, Dash and Admin apps, the Notes session specs signing out in its Dash
 *  (NOTES_BASE_URL, VOICE_BASE_URL, DASH_BASE_URL, ADMIN_BASE_URL; their specs fail in CI without
 *  them). The suite's line, `passed` or `failed`, then goes to the CI trace job, which writes it
 *  under the PR body's status line (`handOverSuiteLine`). The e2e rows tagged `slow` run as asked,
 *  else as the PR's label and paths say (scripts/slow-rows.ts); `only` runs them alone and is no
 *  verdict on the PR, so it writes no line. Vitest gets the choice as E2E_SLOW_ROWS, which holds each
 *  row to its timeout ceiling (e2e/support/setup.ts).
 *
 *  A CI job that deploys its preview in the same run starts beside the deploy, not after it
 *  (PREVIEW_AWAIT_DEPLOY_JOB names the deploy job). It sets the suite up while the preview deploys,
 *  with everything before the first test that needs no preview: the slow rows' choice, Chromium's
 *  install and the warm-ups (`warmUp`). Then it waits for the deploy (scripts/ci/await-deploy.ts),
 *  and only then reads the deployed target and starts the suite. A deploy that did not finish fails
 *  the job with no suite line: the PR body's status line already says the deploy failed. */
async function runSuite(
  suite: PreviewSuite,
  previewName: string,
  prNumber: string | undefined,
  requestedSlowRows: SlowRows | undefined,
) {
  const url = previewUrl(previewName);
  const appUrl = (name: string) =>
    appPreviewUrl(
      APPS.find((app) => app.name === name)!,
      previewName,
    );
  const deployJob = process.env.PREVIEW_AWAIT_DEPLOY_JOB;
  let statusPr = prNumber;
  const failed = (error: unknown) => {
    handOverSuiteLine(statusPr, { suite, state: "failed", error: describe(error) });
    return new Error(`${PREVIEW_SUITES[suite]} failed against ${url}: ${describe(error)}`);
  };
  let tests: { args: string[]; cwd: string; env: Record<string, string> };
  try {
    tests = await traceOperation("Set up the suite", async () => {
      if (suite === "e2e") {
        const [{ slowRows, reason }] = await Promise.all([
          chooseSlowRows({
            requested: requestedSlowRows,
            prNumber,
            readPullRequest: async () => {
              const [{ data: pull }, paths] = await Promise.all([
                getOctokit().rest.pulls.get(pullRequest(prNumber!)),
                changedPaths(prNumber),
              ]);
              return { labels: pull.labels.map((label) => label.name), paths };
            },
          }),
          deployJob &&
            warmUp(
              "the e2e suite's modules",
              "pnpm",
              ["exec", "vitest", "list", "--configLoader", "runner", "--project", "e2e"],
              { cwd: ROOT, env: { WORKER_BASE_URL: url } },
            ),
        ]);
        console.log(`[slow-rows] ${slowRows}: ${reason}`);
        if (slowRows === "only") statusPr = undefined;
        // `e2e:run`, not `e2e`: the deployed target needs no local build.
        return {
          args: ["e2e:run", ...slowRowsTagsFilter(slowRows)],
          cwd: ROOT,
          env: {
            WORKER_BASE_URL: url,
            E2E_SLOW_ROWS: slowRows,
            ...PREVIEW_SUITE_TELEMETRY["preview-e2e"],
          },
        };
      }
      const env = {
        WORKER_BASE_URL: url,
        NOTES_BASE_URL: appUrl("notes"),
        VOICE_BASE_URL: appUrl("voice"),
        DASH_BASE_URL: appUrl("dash"),
        ADMIN_BASE_URL: appUrl("admin"),
      };
      if (process.env.CI)
        await runAsync("pnpm", ["exec", "playwright", "install", "chromium"], { cwd: REPO_ROOT });
      if (deployJob)
        await Promise.all([
          // one launch of the browser the specs launch, headless
          warmUp(
            "Chromium",
            "node",
            [
              "--input-type=module",
              "-e",
              "import { chromium } from '@playwright/test'; await (await chromium.launch()).close();",
            ],
            { cwd: REPO_ROOT },
          ),
          // --list loads the config and every spec, and runs no global setup
          warmUp(
            "the specs' modules",
            "pnpm",
            [
              "exec",
              "playwright",
              "test",
              "--config",
              "playwright.config.ts",
              "--list",
              "--reporter=null",
            ],
            { cwd: REPO_ROOT, env },
          ),
        ]);
      return { args: ["spec"], cwd: REPO_ROOT, env: { ...env, ...PREVIEW_SUITE_TELEMETRY.specs } };
    });
  } catch (error) {
    throw failed(error);
  }
  if (deployJob)
    await traceOperation("Wait for Deploy preview", () => awaitDeployOfThisRun(deployJob));
  await writeDeployedTarget(
    previewName,
    // the client apps the specs run against; the vitest rows use none
    suite === "specs"
      ? ["notes", "voice", "dash", "admin"].map((name) => ({ name, url: appUrl(name) }))
      : [],
  );
  try {
    await runAsync("pnpm", tests.args, { cwd: tests.cwd, env: tests.env });
  } catch (error) {
    throw failed(error);
  }
  handOverSuiteLine(statusPr, { suite, state: "passed" });
}

/** A command run only to read, while the preview deploys, what its suite reads before its first
 *  test: the CI image loads lazily, so a cold runner's first read of node_modules, a test file or
 *  Chromium's binary costs seconds (docs/depot-ci.md#custom-image), and Playwright keeps what it
 *  compiles for the specs in its transform cache. Nothing it runs reaches the preview or writes test
 *  evidence: the variables that make a runner write telemetry, flake records or trace markers are
 *  left out. Its output stays out of the log, and its failure is a warning, since the suite that
 *  follows reports what is wrong itself. */
async function warmUp(
  what: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) {
  const started = Date.now();
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([name]) => !/^(TEST_TELEMETRY_|FLAKE_RECORD_DIR$|CI_TRACE_ENABLED$)/.test(name),
    ),
  );
  const result = await run(command, args, { cwd: options.cwd, env });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  if (result.status === 0) console.log(`[warm-up] ${what}: ${took}`);
  else
    console.warn(
      `[warm-up] ${what} exited ${result.status} after ${took}; the suite runs anyway:\n${lastLines(`${result.stdout}\n${result.stderr}`, 20)}`,
    );
}

// ── sweep (cloudflare-os: GitHub has no `environment.auto_stop_in`) ────────────────────────────

/** A 404 is an answer: the number came out of a live preview's name, so a PR that does not exist
 *  means the preview outlived it. A transient failure must never be what deletes a preview an open
 *  PR still uses, so it falls back to age alone. */
async function pullRequestState(number: number): Promise<PullRequestState> {
  try {
    const github = createOctokit(process.env.GITHUB_TOKEN);
    return (await github.rest.pulls.get(pullRequest(number))).data.state;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return "missing";
    console.warn(`${describe(error)}; PR #${number}'s preview is judged on age alone.`);
    return "unknown";
  }
}

/** Every open pull request's head branch — what keeps a preview named after a branch (preview-sweep.ts
 *  rule 3) — or undefined when GitHub cannot say, and rule 3 then deletes nothing. */
async function openPullRequestBranches() {
  try {
    const github = getOctokit();
    const pulls = await github.paginate(github.rest.pulls.list, {
      ...getRepo(),
      state: "open",
      per_page: 100,
    });
    return pulls.map((pull) => pull.head.ref);
  } catch (error) {
    console.warn(`${describe(error)}; previews without a PR number are judged on age alone.`);
    return undefined;
  }
}

/** Every KV namespace, D1 and Artifacts namespace on the account, and every R2 bucket whose name
 *  begins with the parent's — each a candidate for preview-sweep.ts rule 4. */
async function listSweptResources(cf: Cf): Promise<SweptResource[]> {
  // R2 pages by cursor, which the API client does not hand back: one page of the API's ceiling,
  // narrowed to the parent's prefix, and a full one refused.
  const { buckets } = await cf<{ buckets: { name: string; creation_date?: string }[] }>(
    `/r2/buckets?name_contains=${PREVIEW_PARENT.workerName}-&per_page=1000`,
  );
  if (buckets.length >= 1000)
    throw new Error("1000 or more R2 buckets: the listing may be cut off");
  return [
    ...(await listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces")).map((row) => ({
      kind: "kv" as const,
      name: row.title,
      id: row.id,
    })),
    ...buckets.map((bucket) => ({
      kind: "r2" as const,
      name: bucket.name,
      id: bucket.name,
      createdAt: bucket.creation_date,
    })),
    ...(await listAll<D1Row>(cf, "/d1/database")).map((row) => ({
      kind: "d1" as const,
      name: row.name,
      id: row.uuid,
      createdAt: row.created_at,
    })),
    ...(await listAll<ArtifactsNamespaceRow>(cf, "/artifacts/namespaces")).map((row) => ({
      kind: "artifacts" as const,
      name: row.namespace,
      id: row.namespace,
      createdAt: row.created_at,
    })),
  ];
}

type ListedPreview = { name: string; created_on?: string; deployed_on?: string };

/** A worker's previews; none for a worker that does not exist (a parent never deployed, or one
 *  already deleted). */
const listWorkerPreviews = (cf: Cf, workerName: string) =>
  listAll<ListedPreview>(cf, `/workers/workers/${workerName}/previews`).catch((error) => {
    if (!isMissingWorkerError(describe(error))) throw error;
    return [];
  });

const RESOURCE_KIND_LABELS: Record<SweptResource["kind"], string> = {
  kv: "KV namespace",
  r2: "R2 bucket",
  d1: "D1",
  artifacts: "Artifacts namespace",
};

/** The stale previews (deletePreview, and the apps on top of the same name), the resources that
 *  outlived their preview, the stale per-commit deployments and the former parents with no preview
 *  left, by the rules in scripts/preview-sweep.ts. */
async function sweep(cf: Cf, options: { dryRun: boolean; jobUrl: string | undefined }) {
  const { dryRun } = options;
  // The resources BEFORE the previews (rule 5): wrangler creates a preview before its KV and R2.
  const resources = await listSweptResources(cf);
  const previews = await listAll<ListedPreview>(
    cf,
    `/workers/workers/${PREVIEW_PARENT.workerName}/previews`,
  );
  console.log(
    `${previews.length} preview(s) on ${PREVIEW_PARENT.workerName}; ${resources.length} KV namespaces, R2 buckets, D1s and Artifacts namespaces to judge`,
  );
  // An app's preview without an apps/os preview of the same name is a leftover of a failed delete.
  const appPreviews: { app: StartApp; name: string }[] = [];
  for (const app of APPS) {
    const listed = await listWorkerPreviews(cf, app.envs.preview!.workerName);
    for (const preview of listed) appPreviews.push({ app, name: preview.name });
  }
  const formerParentPreviews = (
    await Promise.all(
      FORMER_PARENTS.map(async (parent) =>
        (await listWorkerPreviews(cf, parent)).map((preview) => ({
          parent,
          name: preview.name,
          lastDeployedAt: preview.deployed_on || preview.created_on,
        })),
      ),
    )
  ).flat();
  const workers = (await cf<{ id: string; created_on?: string }[]>("/workers/scripts")).map(
    (script) => ({ name: script.id, createdAt: script.created_on }),
  );
  const namespaces = await listAll<SweptNamespace>(cf, "/workers/durable_objects/namespaces");
  const deployedWorkerNames = accountWorkerNames();
  const resourceSuffixes = previewResourceSuffixes();
  const accountResources = accountResourceNames();
  // The pull requests the rules read: a preview's (rule 2), a leftover D1's or Artifacts namespace's
  // (rule 6), a per-commit deployment's prefix's (rule 8).
  const pullRequestNumbers = new Set(
    [
      ...previews.map((preview) => preview.name),
      ...resources
        .filter((resource) => resource.kind === "d1" || resource.kind === "artifacts")
        .map(
          (resource) =>
            previewNameOfSweptResource(resource, {
              workers,
              accountResourceNames: accountResources,
              resourceSuffixes,
            }) || "",
        ),
      ...groupPreviewDeployments({
        workers,
        deployedWorkerNames,
        resources,
        resourceSuffixes,
      }).map((deployment) => deployment.prefix),
    ]
      .map((name) => previewPullRequestNumber(name))
      .filter((number) => number !== undefined),
  );
  const pullRequestStates = new Map<number, PullRequestState>();
  for (const number of pullRequestNumbers)
    pullRequestStates.set(number, await pullRequestState(number));
  const plan = planPreviewSweep({
    now: Date.now(),
    workers,
    deployedWorkerNames,
    accountResourceNames: accountResources,
    resourceSuffixes,
    previews: previews.map((preview) => ({
      name: preview.name,
      lastDeployedAt: preview.deployed_on || preview.created_on,
    })),
    formerParentPreviews,
    resources,
    pullRequestStates,
    openPullRequestBranches: await openPullRequestBranches(),
  });
  const stale = plan.previews.filter((preview) => preview.verdict === "stale");
  const staleFormerParentPreviews = plan.formerParentPreviews.filter(
    (preview) => preview.verdict === "stale",
  );
  const staleDeployments = plan.deployments.filter((deployment) => deployment.verdict === "stale");
  const staleFormerParents = plan.formerParents.filter((parent) => parent.verdict === "stale");
  // a former parent is deleted like a deployment: its worker, if any is left, then its resources
  const formerParentGroups = staleFormerParents.map(({ name, worker, resources }) => ({
    workers: worker ? [{ name }] : [],
    resources,
  }));
  const staleNames = new Set(stale.map(({ name }) => name));
  const listedNames = new Set(previews.map((preview) => preview.name));
  const staleAppPreviews = appPreviews.filter(
    ({ name }) => staleNames.has(name) || !listedNames.has(name),
  );
  for (const { name, verdict, reason } of plan.previews)
    console.log(`  ${verdict === "stale" ? "delete" : "keep  "} preview ${name}: ${reason}`);
  for (const orphan of plan.orphans)
    console.log(
      `  delete orphan ${RESOURCE_KIND_LABELS[orphan.kind]} ${orphan.name}: ${orphan.reason}`,
    );
  for (const { app, name } of staleAppPreviews)
    console.log(`  delete apps/${app.name} preview ${name}`);
  for (const { parent, name, verdict, reason } of plan.formerParentPreviews)
    console.log(
      `  ${verdict === "stale" ? "delete" : "keep  "} ${parent} preview ${name}: ${reason}`,
    );
  for (const { name, workers, resources, verdict, reason } of plan.deployments)
    console.log(
      `  ${verdict === "stale" ? "delete" : "keep  "} deployment ${name} (${workers.length} workers, ${resources.length} resources): ${reason}`,
    );
  for (const { name, worker, resources, verdict, reason } of plan.formerParents)
    console.log(
      `  ${verdict === "stale" ? "delete" : "keep  "} former parent ${name} (${worker ? "its worker" : "no worker"}, ${resources.length} resources: ${resources.map((resource) => resource.name).join(", ") || "none"}): ${reason}`,
    );
  // What the account's Durable Object namespace count (Cloudflare's limit is per account) loses: a
  // deleted worker's, and a deleted Worker Preview's (`<worker>_<preview>_<class>`, under the
  // worker's script).
  const deletedWorkers = new Set([
    ...staleDeployments.flatMap((deployment) => deployment.workers.map(({ name }) => name)),
    ...formerParentGroups.flatMap((group) => group.workers.map(({ name }) => name)),
  ]);
  const deletedPreviews = [
    ...stale.map(({ name }) => ({ worker: PREVIEW_PARENT.workerName, name })),
    ...staleAppPreviews.map(({ app, name }) => ({ worker: app.envs.preview!.workerName, name })),
    ...staleFormerParentPreviews.map(({ parent, name }) => ({ worker: parent, name })),
  ];
  const freedNamespaceIds = new Set(
    namespaces
      .filter(
        (namespace) =>
          deletedWorkers.has(namespace.script || "") ||
          deletedPreviews.some(
            ({ worker, name }) =>
              namespace.script === worker && namespace.name.startsWith(`${worker}_${name}_`),
          ),
      )
      .map(({ id }) => id),
  );
  const workerless = workerlessNamespaces(namespaces, workers);
  if (plan.unmappedWorkers.length > 0)
    console.log(
      `  keep   ${plan.unmappedWorkers.length} worker(s) envs.ts does not name, for a person to judge: ${plan.unmappedWorkers.join(", ")}`,
    );
  if (workerless.length > 0)
    console.log(
      `  ${workerless.length} Durable Object namespace(s) whose worker is gone, paged if still listed once the run is done (rule 11): ${workerless.map(({ name }) => name).join(", ")}`,
    );
  const orphanCounts = Object.entries(RESOURCE_KIND_LABELS).map(
    ([kind, label]) => `${plan.orphans.filter((orphan) => orphan.kind === kind).length} ${label}`,
  );
  const members = (groups: { workers: unknown[]; resources: unknown[] }[]) =>
    `${groups.flatMap(({ workers }) => workers).length} workers, ${groups.flatMap(({ resources }) => resources).length} resources`;
  console.log(
    [
      `plan: ${stale.length} stale preview(s)`,
      `orphans: ${orphanCounts.join(", ")}`,
      `${staleAppPreviews.length} app preview(s)`,
      `${staleFormerParentPreviews.length} former parents' preview(s)`,
      `${staleDeployments.length} per-commit deployment(s) (${members(staleDeployments)})`,
      `${staleFormerParents.length} former parent(s) (${members(formerParentGroups)})`,
      `${freedNamespaceIds.size} of the account's ${namespaces.length} Durable Object namespaces go with them`,
      `${plan.unmappedWorkers.length} unmapped worker(s) kept`,
    ].join("; "),
  );
  const nothingToDelete =
    stale.length === 0 &&
    plan.orphans.length === 0 &&
    staleAppPreviews.length === 0 &&
    staleFormerParentPreviews.length === 0 &&
    staleDeployments.length === 0 &&
    staleFormerParents.length === 0;
  if (dryRun) return;
  const failures: string[] = [];
  // The Artifacts namespaces Cloudflare will not delete (StuckArtifactsNamespace): paged, and tried
  // again the next night.
  const stuckNamespaces: StuckArtifactsNamespace[] = [];
  const noteStuck = (stuck: StuckArtifactsNamespace | undefined) => {
    if (stuck) stuckNamespaces.push(stuck);
  };
  if (!nothingToDelete) {
    const wrangler = preparePreviewWrangler();
    try {
      await wrangler.ready;
      const deleteResource = async (resource: SweptResource) => {
        const remove = {
          kv: () => deleteKvNamespace(cf, { id: resource.id, title: resource.name }),
          r2: () => deleteR2Bucket(cf, resource.name),
          d1: async () => {
            await cf(`/d1/database/${resource.id}`, { method: "DELETE" });
            console.log(`deleted D1 ${resource.name}`);
          },
          artifacts: async () => noteStuck(await deleteArtifactsNamespace(cf, resource.name)),
        }[resource.kind];
        await remove().catch((error) => failures.push(`${resource.name}: ${describe(error)}`));
      };
      for (const { name } of stale) {
        await deletePreview(cf, name, wrangler.command).then(noteStuck, (error) =>
          failures.push(`${name}: ${describe(error)}`),
        );
      }
      // Each orphan's preview looked up once more, right before its resources go: a preview deployed
      // under that name since the listing (a reset, a redeploy that reuses leftovers by name) keeps them.
      for (const previewName of new Set(plan.orphans.map((orphan) => orphan.previewName))) {
        const previewGone = await cf(
          `/workers/workers/${PREVIEW_PARENT.workerName}/previews/${previewName}`,
        ).then(
          () => {
            console.warn(`preview ${previewName} exists again; its resources stay.`);
            return false;
          },
          (error) => {
            if (isCloudflareError(error, 404, 10025)) return true;
            failures.push(`preview ${previewName}: ${describe(error)}`);
            return false;
          },
        );
        if (!previewGone) continue;
        for (const orphan of plan.orphans.filter((row) => row.previewName === previewName))
          await deleteResource(orphan);
      }
      for (const { app, name } of staleAppPreviews) {
        await deleteWorkerPreview(app.envs.preview!, name, wrangler.command).catch((error) =>
          failures.push(`apps/${app.name} ${name}: ${describe(error)}`),
        );
      }
      for (const { parent, name } of staleFormerParentPreviews) {
        const worker = {
          workerName: parent,
          cloudflareAccountId: PREVIEW_PARENT.cloudflareAccountId,
        };
        await deleteWorkerPreview(worker, name, wrangler.command).catch((error) =>
          failures.push(`${parent} ${name}: ${describe(error)}`),
        );
      }
      // A group's workers first, so nothing writes to its resources as they go. A worker that would
      // not go keeps its group's resources: the next run tries both again, by name.
      for (const { workers, resources } of [...staleDeployments, ...formerParentGroups]) {
        const deleted = await Promise.all(
          workers.map((worker) =>
            deleteWorker(cf, worker.name).then(
              () => true,
              (error) => {
                failures.push(`worker ${worker.name}: ${describe(error)}`);
                return false;
              },
            ),
          ),
        );
        if (deleted.every(Boolean))
          for (const resource of resources) await deleteResource(resource);
      }
    } finally {
      wrangler.cleanup();
    }
  }
  // Once the deletes are done, each namespace they took should be gone from the listing. One still
  // listed after deletes that all succeeded is Cloudflare's: a warn now, and rule 11's page from the
  // next run, which finds it workerless (so a namespace Cloudflare drops a moment late pages no one).
  const listedAfter = await listAll<SweptNamespace>(cf, "/workers/durable_objects/namespaces");
  const outlived = listedAfter.filter(({ id }) => freedNamespaceIds.has(id));
  if (failures.length === 0 && outlived.length > 0)
    console.warn({
      event: "preview.platform-failure-durable-object-namespace-delete",
      namespaces: outlived.map(({ name }) => name),
    });
  else if (freedNamespaceIds.size > 0)
    console.log(
      `${freedNamespaceIds.size - outlived.length} of ${freedNamespaceIds.size} Durable Object namespace(s) went with their worker`,
    );
  // Rule 11: workerless when the run began, and still listed once it is done.
  const listedIds = new Set(listedAfter.map(({ id }) => id));
  const stillWorkerless = workerless.filter(({ id }) => listedIds.has(id));
  // The run is red only when the sweep could not act. A scheduled run reports on main's head
  // commit, where red reads as "this commit broke", so Cloudflare's refusal is a page instead
  // (the rule scripts/ci/prd-fault-alarm.ts follows); a page that could not be posted is a failure.
  const pages = [
    stuckNamespaces.length > 0 &&
      renderStuckArtifactsNamespacesPage(stuckNamespaces, options.jobUrl),
    stillWorkerless.length > 0 && renderWorkerlessNamespacesPage(stillWorkerless, options.jobUrl),
  ].filter((text) => typeof text === "string");
  for (const text of pages) {
    console.log(text);
    await (async () =>
      getSlackClient().chat.postMessage({
        channel: slackChannelIds["#error-pulse"],
        text,
      }))().catch((error) => failures.push(`paging #error-pulse: ${describe(error)}`));
  }
  if (failures.length > 0) throw new Error(`sweep failures:\n  ${failures.join("\n  ")}`);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

type PreviewOptions = {
  /** the pull request's number (else PREVIEW_PR_NUMBER) */
  pr?: string;
  /** the preview's name, for a run without a PR number (else PREVIEW_NAME) */
  name?: string;
  /** the apps on top: all (default, else PREVIEW_APPS), none, or auto (the ones this PR changes) */
  apps?: "all" | "auto" | "none";
  /** e2e: which rows tagged `slow` run — run, skip or only (else E2E_SLOW_ROWS) */
  slowRows?: "run" | "skip" | "only";
  /** print the plan (sweep, reset-parent) or build and write the config only (the rest) */
  dryRun?: boolean;
};

/** One Worker Preview per pull request of the one worker: `pnpm preview <command> [flags]`. */
export default class Preview {
  /** build and write the preview's wrangler config */
  async config(options: PreviewOptions = {}) {
    await main("config", options);
  }
  /** build, the Artifacts namespace, the secrets, `wrangler preview`, the PR body and its status line */
  async deploy(options: PreviewOptions = {}) {
    await main("deploy", options);
  }
  /** the vitest e2e suite against the live preview */
  async e2e(options: PreviewOptions = {}) {
    await main("e2e", options);
  }
  /** the Playwright specs against the live preview */
  async specs(options: PreviewOptions = {}) {
    await main("specs", options);
  }
  /** delete the preview, then deploy it */
  async reset(options: PreviewOptions = {}) {
    await main("reset", options);
  }
  /** the preview, its Artifacts namespace, KV namespaces and R2 bucket, leftover D1, the apps on top */
  async delete(options: PreviewOptions = {}) {
    await main("delete", options);
  }
  /** the stale previews, the old preview workers and the resources that outlived theirs
   *  (scripts/preview-sweep.ts) */
  async sweep(options: PreviewOptions = {}) {
    await main("sweep", options);
  }
  /** the workers every preview branches from, from this checkout */
  async deployParents(options: PreviewOptions = {}) {
    await main("deploy-parents", options);
  }
  /** the `os` parent's own data erased, then the parent deployed again */
  async resetParent(options: PreviewOptions = {}) {
    await main("reset-parent", options);
  }
  /** the CI trace job's: both suites' lines, as their jobs handed them over (PREVIEW_SUITE_LINES,
   *  one a line), into the PR body at once */
  async suiteLines(options: PreviewOptions = {}) {
    await main("suite-lines", options);
  }
}

async function main(command: Command, options: PreviewOptions) {
  const parsed = { ...options, command, dryRun: options.dryRun ?? false };
  const pr = parsed.pr || process.env.PREVIEW_PR_NUMBER;
  const appsMode = parsed.apps || AppsMode.parse(process.env.PREVIEW_APPS || "all");
  if (parsed.command === "sweep")
    return sweep((await parentContext()).cf, {
      dryRun: parsed.dryRun,
      jobUrl: process.env.DEPOT_JOB_URL,
    });
  if (parsed.command === "deploy-parents") return deployParents(await parentContext());
  if (parsed.command === "reset-parent") return resetParent({ dryRun: parsed.dryRun });
  if (parsed.command === "suite-lines")
    return writeSuiteLines(pr, process.env.PREVIEW_SUITE_LINES || "");
  const previewName = resolvePreviewName({
    name: parsed.name || process.env.PREVIEW_NAME,
    prNumber: pr,
  });
  console.log(`preview ${previewName} → ${previewUrl(previewName)}`);
  if (parsed.command === "config" || parsed.dryRun) {
    await buildOs("preview");
    console.log(
      `wrote ${writePreviewWranglerConfig({ previewName, databaseId: "<created at deploy>" })}`,
    );
    return;
  }
  if (parsed.command === "e2e" || parsed.command === "specs")
    return runSuite(
      parsed.command,
      previewName,
      pr,
      parsed.slowRows || SlowRows.optional().parse(process.env.E2E_SLOW_ROWS || undefined),
    );
  const ctx = await parentContext();
  if (parsed.command === "delete") return deleteAll(ctx.cf, previewName);
  if (parsed.command === "reset") await deleteAll(ctx.cf, previewName);
  return deployPreview(ctx, previewName, pr, await appsToPreview(appsMode, pr));
}

if (process.argv[1]?.endsWith("preview.ts"))
  void createCli({ ...import.meta, name: "preview" }).run({ formatError: describe });
