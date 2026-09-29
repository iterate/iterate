// scripts/preview.ts — A FRESH SET OF PLAIN WORKERS PER TESTED COMMIT on the dev/preview account:
// apps/os and each app on top, `<prefix>-<sha7>-<app>` (envs.ts `previewDeployment`), deployed by
// the same build and `wrangler deploy` as prd (scripts/deploy.ts, deployApp). The effects half; the
// pure halves are scripts/preview-config.ts (naming, the PR body's section) and
// scripts/preview-sweep.ts (which deployments go). Commands:
//   config              build apps/os for this commit's deployment and name the config it wrote
//   deploy              this commit's deployment: apps/os (its D1, R2 bucket and Artifacts namespace
//                       created, the D1 migrated), every app on top, the readiness gate, the sign-in
//                       seed, the PR body's section (the previous one folded first)
//   e2e, specs          the vitest e2e suite (`--slow-rows`, scripts/slow-rows.ts) or the Playwright
//                       specs against a deployment: beside its run's deploy, this commit's, once that
//                       deploy is done (PREVIEW_AWAIT_DEPLOY_JOB); else the prefix's newest
//   cleanup-superseded  delete the prefix's deployments PREVIEW_DEPLOYMENT supersedes
//   delete              every deployment of a prefix: a closed PR's (preview-delete.yml)
//   sweep               the stale deployments, the legacy Worker Previews and the former parents
//                       (preview-sweep.ts), nightly (preview-sweep.yml)
//   deploy-parents      main on the dev/preview account, redeployed in place (preview-parents.yml)
//   reset-parent        main on dev's data erased, then deployed again (preview-sweep.yml)
// `--dry-run` prints the plan.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { connectIterate } from "iterate/node";
import type { IngressRouting } from "iterate/project-ingress";
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { z } from "zod";
import {
  TestEvidenceTarget,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import {
  OS_DOPPLER_PROJECT,
  getDeployTarget,
  getOsDeployTarget,
  osEnvs,
  previewDeployment,
  type OsEnv,
} from "../../../envs.ts";
import {
  appConfigSecretsOf,
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
import { buildStartApp, type StartApp } from "../../../scripts/lib/start-app.ts";
import { awaitDeployOfThisRun, SUITE_BOUND_MS } from "../../../scripts/ci/await-deploy.ts";
import { depotApi, workflowsInProgress } from "../../../scripts/ci/depot.ts";
import { createOctokit, getOctokit, getRepo } from "../../../scripts/ci/github.ts";
import { replaceMarkedSection } from "../../../scripts/ci/markdown-annotator.ts";
import {
  githubPullRequestBody,
  writePullRequestBody,
} from "../../../scripts/ci/pull-request-body.ts";
import { getSlackClient, keepPage, slackChannelIds } from "../../../scripts/ci/slack.ts";
import { traceOperation } from "../../../scripts/ci/tracing/tracing.ts";
import { parseAppConfig, type AppConfig } from "../src/app-config.ts";
import { TEST_EMAIL_DOMAIN } from "../src/test-email-domain.ts";
import { buildOs } from "./build.ts";
import type { D1Row } from "./d1.ts";
import deployOs from "./deploy.ts";
import eraseData from "./erase-data.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";
import { awaitPreviewReady } from "./preview-readiness.ts";
import {
  deleteArtifactsNamespace,
  isCloudflareError,
  renderStuckArtifactsNamespacesPage,
  STUCK_ARTIFACTS_PAGE_MARKER,
  stuckNamespacesStillThere,
  type ArtifactsNamespaceRow,
  type Cf,
  type StuckArtifactsNamespace,
} from "./preview-artifacts.ts";
import {
  accountResourceNames,
  accountWorkerNames,
  APPS,
  appSignInLink,
  assertFreshInstall,
  configTemplateNames,
  foldPreviousPreviewSection,
  FORMER_PARENTS,
  MAIN_ON_DEV,
  previewDeploymentName,
  previewDeploymentUrls,
  previewPullRequestNumber,
  proxiedAppRoute,
  PROXIED_APPS,
  renderPullRequestSection,
  PREVIEW_SECTION,
  resolvePreviewPrefix,
  signInLinkOf,
  templateQuickLaunches,
} from "./preview-config.ts";
import {
  CI_WORKFLOW_PREVIEWS,
  groupPreviewDeployments,
  newestPreviewDeployment,
  planFormerParents,
  planLegacyWorkerPreviewSweep,
  planPreviewSweep,
  planSupersededCleanup,
  previewMemberSuffixes,
  renderWorkerlessNamespacesPage,
  unmappedWorkers,
  workerlessNamespaces,
  WORKERLESS_PAGE_MARKER,
  type PreviewDeploymentListing,
  type PreviewMember,
  type PullRequestState,
  type SweptNamespace,
} from "./preview-sweep.ts";
import { chooseSlowRows, slowRowsTagsFilter, type SlowRows } from "./slow-rows.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "../..");
const OUTPUT_DIR = path.join(ROOT, "output");

const Command = z.enum([
  "config",
  "deploy",
  "e2e",
  "specs",
  "cleanup-superseded",
  "delete",
  "sweep",
  "deploy-parents",
  "reset-parent",
]);
type Command = z.infer<typeof Command>;

/** Main on dev's Doppler config (envs.ts `OS_DOPPLER_PROJECT`, config `preview`), downloaded — the
 *  Cloudflare credentials for the dev/preview account and the two secrets every apps/os deploy
 *  there ships — the way ensure-resources and erase-data resolve theirs. Refuses a Doppler account
 *  that is not the dev/preview one. */
const accountContext = () =>
  resolveEnvContext({
    env: getDeployTarget("preview", osEnvs),
    dopplerProject: OS_DOPPLER_PROJECT,
  });

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Every row of a paged account listing — KV, D1 and Artifacts namespaces all page the same way
 *  (`per_page`, `page`). */
async function listAll<T>(cf: Cf, route: string) {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await cf<T[]>(
      `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

// ── GitHub (scripts/ci/github.ts: a 5xx on a read or a whole-body write is asked again) ─────────

/** The pull request `number` of this repository (GITHUB_REPOSITORY), as Octokit's parameters. */
const pullRequest = (number: string | number) => ({ ...getRepo(), pull_number: Number(number) });

/** The PR's body on GitHub, written by scripts/ci/pull-request-body.ts `writePullRequestBody`. */
const pullRequestBody = (prNumber: string) =>
  githubPullRequestBody(getOctokit(), getRepo(), Number(prNumber));

/** The commit this checkout is: the one the job deployed or tested (the PR merged into main in CI). */
function checkedOutCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// ── the account's deployments: listed, grouped by name (preview-sweep.ts), deleted ─────────────

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

/** One already gone — a PR's close racing the sweep, a re-run — is deleted: Cloudflare's 404/7404,
 *  the not-found wrangler reads a D1 lookup by. */
async function deleteD1(cf: Cf, row: { uuid: string; name: string }) {
  await cf(`/d1/database/${row.uuid}`, { method: "DELETE" }).catch((error) => {
    if (!isCloudflareError(error, 404, 7404)) throw error;
  });
  console.log(`deleted D1 ${row.name}`);
}

/** A deployment's members' suffixes (preview-sweep.ts `previewMemberSuffixes`), wrangler naming
 *  its KV after the template's bindings. */
const memberSuffixes = () =>
  previewMemberSuffixes(
    readWranglerBase().kv_namespaces.map(({ binding }: { binding: string }) => binding),
  );

/** Every worker, KV namespace, R2 bucket (of a deployment's or a former parent's shape), D1 and
 *  Artifacts namespace on the account. */
async function listAccountMembers(cf: Cf) {
  // R2 pages by cursor, which the API client does not hand back: one page of the API's ceiling,
  // narrowed to the `…-files` buckets a deployment and a former parent's previews have, and a full
  // one refused.
  const [scripts, kv, { buckets }, d1, artifacts] = await Promise.all([
    cf<{ id: string; created_on?: string }[]>("/workers/scripts"),
    listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces"),
    cf<{ buckets: { name: string; creation_date?: string }[] }>(
      "/r2/buckets?name_contains=-files&per_page=1000",
    ),
    listAll<D1Row>(cf, "/d1/database"),
    listAll<ArtifactsNamespaceRow>(cf, "/artifacts/namespaces"),
  ]);
  if (buckets.length >= 1000)
    throw new Error("1000 or more R2 buckets: the listing may be cut off");
  const members: PreviewMember[] = [
    ...scripts.map((row): PreviewMember => ({
      kind: "worker",
      name: row.id,
      id: row.id,
      createdAt: row.created_on,
    })),
    ...kv.map((row): PreviewMember => ({ kind: "kv", name: row.title, id: row.id })),
    ...buckets.map((row): PreviewMember => ({
      kind: "r2",
      name: row.name,
      id: row.name,
      createdAt: row.creation_date,
    })),
    ...d1.map((row): PreviewMember => ({
      kind: "d1",
      name: row.name,
      id: row.uuid,
      createdAt: row.created_at,
    })),
    ...artifacts.map((row): PreviewMember => ({
      kind: "artifacts",
      name: row.namespace,
      id: row.namespace,
      createdAt: row.created_at,
    })),
  ];
  return members;
}

/** Every per-commit deployment on the account, grouped by name (preview-sweep.ts
 *  `groupPreviewDeployments`). */
async function listPreviewDeployments(cf: Cf) {
  return groupPreviewDeployments(await listAccountMembers(cf), memberSuffixes());
}

/** A deployment's workers first, so nothing writes to what goes next, then its KV, R2 bucket, D1
 *  and Artifacts namespace; each member one at a time settles before any failure is named. One
 *  already gone is the expected case. Resolves to its Artifacts namespace when Cloudflare will not
 *  delete it (StuckArtifactsNamespace): the rest still goes, and the nightly sweep retries and
 *  pages it. */
async function deletePreviewDeployment(cf: Cf, deployment: PreviewDeploymentListing) {
  const failures: string[] = [];
  const stuck: StuckArtifactsNamespace[] = [];
  const settle = async (
    members: PreviewMember[],
    remove: (member: PreviewMember) => Promise<void>,
  ) => {
    const results = await Promise.allSettled(members.map(remove));
    results.forEach((result, index) => {
      if (result.status === "rejected")
        failures.push(`${members[index]!.name}: ${describe(result.reason)}`);
    });
  };
  const workers = deployment.members.filter((member) => member.kind === "worker");
  await settle(workers, async ({ name }) => {
    // `force`: a worker with Durable Object namespaces is refused without it
    await cf(`/workers/scripts/${name}?force=true`, { method: "DELETE" }).catch((error) => {
      if (!isCloudflareError(error, 404, 10007)) throw error;
    });
    console.log(`deleted worker ${name}`);
  });
  await settle(
    deployment.members.filter((member) => member.kind !== "worker"),
    async (member) => {
      if (member.kind === "kv") return deleteKvNamespace(cf, { id: member.id, title: member.name });
      if (member.kind === "r2") return deleteR2Bucket(cf, member.name);
      if (member.kind === "d1") return deleteD1(cf, { uuid: member.id, name: member.name });
      const refused = await deleteArtifactsNamespace(cf, member.name);
      if (refused) stuck.push(refused);
    },
  );
  if (failures.length > 0)
    throw new Error(
      `${deployment.name}: ${failures.length} member(s) not deleted\n  ${failures.join("\n  ")}`,
    );
  console.log(`deleted deployment ${deployment.name} (${deployment.members.length} members)`);
  return stuck;
}

/** Delete each of `deployments`, then fail naming the ones that did not go. A namespace Cloudflare
 *  will not delete does not fail it: the caller reports on a commit that did not cause it, and the
 *  nightly sweep retries and pages it. */
async function deletePreviewDeployments(cf: Cf, deployments: PreviewDeploymentListing[]) {
  const failures: string[] = [];
  const stuckNamespaces: StuckArtifactsNamespace[] = [];
  for (const deployment of deployments) {
    await deletePreviewDeployment(cf, deployment).then(
      (stuck) => stuckNamespaces.push(...stuck),
      (error) => failures.push(describe(error)),
    );
  }
  return { failures, stuckNamespaces };
}

/** THE PREFIX'S DEPLOYMENTS THIS ONE SUPERSEDES (preview-sweep.ts `planSupersededCleanup`): each
 *  run's `Clean up superseded` job, once its own deployment is ready. Never the run's verdict: the
 *  job does not gate the checks, and what it leaves the next run's cleanup or the sweep takes. */
async function cleanupSuperseded(cf: Cf, name: string, options: { dryRun: boolean }) {
  const deployments = await listPreviewDeployments(cf);
  const underTest = await deploymentsUnderTest(name);
  for (const deployment of deployments)
    if (deployment.name !== name && underTest.has(deployment.name))
      console.log(`  keep ${deployment.name}: a run still in progress tests it`);
  const superseded = planSupersededCleanup(deployments, name, underTest);
  for (const deployment of superseded)
    console.log(
      `  ${options.dryRun ? "would delete" : "delete"} ${deployment.name}: superseded by ${name}`,
    );
  console.log(`${superseded.length} deployment(s) superseded by ${name}`);
  if (options.dryRun) return;
  const { failures, stuckNamespaces } = await deletePreviewDeployments(cf, superseded);
  for (const stuck of stuckNamespaces)
    console.warn(
      `Artifacts namespace ${stuck.namespace} stays: Cloudflare will not delete it; the nightly sweep retries and pages #error-pulse.`,
    );
  if (failures.length > 0) throw new Error(`cleanup failures:\n  ${failures.join("\n  ")}`);
}

/** The deployments of `name`'s prefix that a run still in progress tests. A CI workflow's own prefix
 *  (preview-sweep.ts CI_WORKFLOW_PREVIEWS): `<prefix>-<sha7>` of each queued or running run of that
 *  workflow, whatever started it, from Depot. A PR's: none, since its next push cancels the run in
 *  progress. */
async function deploymentsUnderTest(name: string): Promise<ReadonlySet<string>> {
  const prefix = previewDeployment(name)?.prefix || "";
  const workflow = CI_WORKFLOW_PREVIEWS.get(prefix);
  if (!workflow) return new Set();
  const runs = await workflowsInProgress(depotApi(), { name: workflow });
  return new Set(runs.map((run) => previewDeploymentName(prefix, run.sha)));
}

/** EVERY DEPLOYMENT OF A PREFIX: a closed PR's (preview-delete.yml), or a name's by hand. */
async function deletePrefix(cf: Cf, prefix: string, options: { dryRun: boolean }) {
  const deployments = (await listPreviewDeployments(cf)).filter(
    (deployment) => deployment.prefix === prefix,
  );
  for (const deployment of deployments)
    console.log(
      `  ${options.dryRun ? "would delete" : "delete"} ${deployment.name} (${deployment.members.length} members)`,
    );
  console.log(`${deployments.length} deployment(s) of ${prefix}`);
  if (options.dryRun) return;
  const { failures, stuckNamespaces } = await deletePreviewDeployments(cf, deployments);
  for (const stuck of stuckNamespaces)
    console.warn(
      `Artifacts namespace ${stuck.namespace} stays: Cloudflare will not delete it; the nightly sweep retries and pages #error-pulse.`,
    );
  if (failures.length > 0) throw new Error(`delete failures:\n  ${failures.join("\n  ")}`);
}

/** The deployment a suite tests away from its run's deploy (a test-only dispatch, a laptop): the
 *  prefix's newest. */
async function deploymentToTest(prefix: string) {
  const newest = newestPreviewDeployment(
    await listPreviewDeployments((await accountContext()).cf),
    prefix,
  );
  if (!newest) throw new Error(`${prefix} has no deployment to test: deploy one first`);
  console.log(`testing ${prefix}'s newest deployment, ${newest.name}`);
  return newest.name;
}

// ── the apps on top, and main on dev ───────────────────────────────────────────────────────────

/** One app on top, from its own build for `envName` (start-app.ts `startAppWorkerConfig`: a
 *  per-commit deployment's signs in against that deployment's apps/os and links to its apps), and
 *  the smoke that it answers at `url`. An app is an OAuth client and nothing else: no secrets, no
 *  data of its own, one Durable Object class for the browser session. */
async function deployStartApp(
  app: StartApp,
  envName: string,
  url: string,
  credentials: Record<string, string>,
) {
  const root = path.resolve(import.meta.dirname, "../..", app.name);
  await buildStartApp(app, envName);
  await deployWithSecrets({
    cwd: root,
    builtConfig: findBuiltWranglerConfig(root),
    secretValues: {},
    credentials,
  });
  await smoke(`${url}/healthz`, (response) => response.status === 200, `apps/${app.name} health`);
  return { name: app.name, url };
}

/** MAIN ON THE DEV/PREVIEW ACCOUNT, from this checkout, in place: apps/os's `os` (envs.ts
 *  osEnvs.preview) as any OS deployment deploys (scripts/deploy.ts: its own resources, its Doppler
 *  secrets, its smokes), and each app's from its `preview` build, which signs in against `os` and
 *  links to the others (start-app.ts startAppWorkerConfig). preview-parents.yml runs this on every
 *  push to main. Nothing a PR deploys depends on it. Side by side; every one settles before the
 *  failed ones are named. */
async function deployParents(ctx: EnvContext<OsEnv>) {
  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN!,
    CLOUDFLARE_ACCOUNT_ID: MAIN_ON_DEV.cloudflareAccountId,
  };
  const steps = [
    { name: "apps/os", deploy: () => deployOs({ env: "preview" }) },
    ...APPS.map((app) => ({
      name: `apps/${app.name}`,
      deploy: () => deployStartApp(app, "preview", app.envs.preview!.baseUrl, credentials),
    })),
  ];
  const results = await Promise.allSettled(steps.map((step) => step.deploy()));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [`${steps[index]!.name}: ${describe(result.reason)}`] : [],
  );
  if (failures.length) throw new Error(`main on dev failed\n\n${failures.join("\n\n")}`);
  console.log(
    `✅ main on dev deployed: ${[MAIN_ON_DEV, ...APPS.map((app) => app.envs.preview!)].map((env) => env.baseUrl).join(", ")}`,
  );
}

/** THE NIGHTLY RESET of main on dev's own data (preview-sweep.yml): what people and agents left on
 *  os.iterate-dev-preview.workers.dev and the apps signed in against it — its Durable Objects, its
 *  D1's rows (users, organizations, projects), KV, R2 and Artifacts repos — erased
 *  (scripts/erase-data.ts), then it is deployed again from this checkout. The per-commit
 *  deployments are workers of their own and keep serving throughout. The apps hold nothing worth
 *  a reset: a browser session each, which the next sign-in replaces. */
async function resetParent(options: { dryRun: boolean }) {
  await eraseData({ env: "preview", dryRun: options.dryRun });
  if (options.dryRun) return;
  await deployOs({ env: "preview" });
}

// ── the deployment ─────────────────────────────────────────────────────────────────────────────

/** The deploy, with the PR body's section folded into a previous commit's beside it
 *  (preview-config.ts `foldPreviousPreviewSection`): a deploy that fails leaves it folded, and one
 *  that lands writes its own section after the fold has landed. A body write that fails is logged,
 *  never the deploy's failure. */
async function deployPreview(
  ctx: EnvContext<OsEnv>,
  name: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  const folded =
    prNumber && process.env.GITHUB_TOKEN
      ? traceOperation("Fold the previous section", () =>
          writePullRequestBody(
            pullRequestBody(prNumber),
            "the folded previous section",
            foldPreviousPreviewSection,
          ),
        ).catch((error: unknown) =>
          console.warn(`could not fold the previous section: ${describe(error)}`),
        )
      : Promise.resolve();
  await deployPreviewSteps(ctx, name, prNumber, apps, folded);
}

/** The version this deploy made current, as Cloudflare records it: the worker's latest deployment
 *  (the first listed), all of its traffic on one version, the id `/version` answers with
 *  (src/worker.ts). Read from the API, not from `/version`, because a brand-new workers.dev hostname
 *  answers 404 from some locations for seconds after the deploy's smokes have passed. */
async function deployedVersion(ctx: EnvContext<OsEnv>, workerName: string) {
  const { deployments } = await ctx.cf<{
    deployments: { versions: { version_id: string; percentage: number }[] }[];
  }>(`/workers/scripts/${workerName}/deployments`);
  const versions = deployments[0]?.versions ?? [];
  if (versions.length !== 1 || versions[0]!.percentage !== 100)
    throw new Error(
      `${workerName}'s latest deployment is not one version at 100%: ${JSON.stringify(versions)}`,
    );
  return versions[0]!.version_id;
}

/** apps/os (scripts/deploy.ts: its resources created, its D1 migrated, its secrets, its smokes) and
 *  each app on top, side by side, each a span in the CI trace (docs/ci-traces.md); every URL is
 *  known before anything deploys (envs.ts `previewDeployment`). Every step settles before a failed
 *  one fails the deploy, named. Then the readiness gate on apps/os, and once it passes the sign-in
 *  seed and the PR body's section side by side. */
async function deployPreviewSteps(
  ctx: EnvContext<OsEnv>,
  name: string,
  prNumber: string | undefined,
  apps: StartApp[],
  folded: Promise<void>,
) {
  assertFreshInstall(REPO_ROOT);
  const urls = previewDeploymentUrls(name);
  // the paths this PR changes, for the Dash's template links (signInLinks), read beside the builds
  const changed =
    prNumber && apps.some((app) => app.name === "dash")
      ? changedPaths(prNumber).catch((error: unknown) => {
          console.warn(
            `sign-in: ${describe(error)}; every template link names the deployment's own copy`,
          );
          return [];
        })
      : Promise.resolve([]);
  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN!,
    CLOUDFLARE_ACCOUNT_ID: MAIN_ON_DEV.cloudflareAccountId,
  };
  const steps = [
    { step: "apps/os", done: traceOperation("Deploy OS", () => deployOs({ env: name })) },
    ...apps.map((app) => ({
      step: `apps/${app.name}`,
      done: traceOperation(`Deploy ${app.name}`, () =>
        deployStartApp(app, name, urls.apps[app.name]!, credentials),
      ),
    })),
  ];
  const failures = (await Promise.allSettled(steps.map(({ done }) => done))).flatMap(
    (result, index) =>
      result.status === "rejected"
        ? [{ step: steps[index]!.step, error: describe(result.reason) }]
        : [],
  );
  // the failed steps on the first line (the PR body's summary), each one's error and output tail after it
  if (failures.length === 1) throw new Error(`${failures[0]!.step}: ${failures[0]!.error}`);
  if (failures.length > 1)
    throw new Error(
      `${failures.map(({ step }) => step).join(", ")} failed\n\n${failures.map(({ step, error }) => `${step}: ${error}`).join("\n\n")}`,
    );
  const deployedApps = apps.map((app) => ({ name: app.name, url: urls.apps[app.name]! }));
  const url = urls.os;
  const versionId = await deployedVersion(ctx, getOsDeployTarget(name).workerName);
  const config = parseAppConfig({
    ...collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]),
    ...appConfigSecretsOf(ctx.secrets),
  });
  // The gate (preview-readiness.ts says why): nothing is handed on — the PR body's links, the
  // sign-in seed, the suites — until three rounds of eight in a row answer in full on this version.
  await traceOperation("Readiness gate", () =>
    awaitPreviewReady(url, {
      adminSecret: config.secrets.adminBearer.exposeSecret(),
      version: versionId,
      width: 8,
      consecutive: 3,
    }),
  );
  console.log(`\ndeployment ${name}: ${url}`);
  const signIn = prNumber
    ? signInLinks({
        url,
        ingressRouting: getOsDeployTarget(name).ingressRouting || null,
        // every per-commit deployment's admins sign in through prd (envs.ts `previewDeployment`)
        providerHint: new URL(getOsDeployTarget(name).adminIssuer!).host,
        prNumber,
        apps: deployedApps,
        changedPaths: await changed,
      })
    : undefined;
  const publish = async (seeded: boolean) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIR, "preview.json"),
      `${JSON.stringify({ deployment: name, url, versionId, apps: deployedApps }, null, 2)}\n`,
    );
    if (!prNumber || !signIn || !process.env.GITHUB_TOKEN) return;
    await folded;
    const dashboardUrl = (worker: string) =>
      `https://dash.cloudflare.com/${MAIN_ON_DEV.cloudflareAccountId}/workers/services/view/${worker}/production`;
    const section = renderPullRequestSection({
      deployment: name,
      workers: [
        { name: "os", url, signIn: signIn.heading, dashboardUrl: dashboardUrl(`${name}-os`) },
        ...deployedApps.map((app) => ({
          ...app,
          signIn: signIn.apps[app.name]!,
          dashboardUrl: dashboardUrl(`${name}-${app.name}`),
        })),
      ],
      templates: signIn.templates,
      seed: { project: signIn.project, seeded },
    });
    await traceOperation("Write the PR section", () =>
      writePullRequestBody(pullRequestBody(prNumber), "the preview section", (body) =>
        replaceMarkedSection(body, PREVIEW_SECTION, section),
      ),
    );
  };
  // The seed and the section side by side: a seed that failed rewrites the section to say so.
  const [seeded] = await Promise.all([
    signIn
      ? traceOperation("Seed sign-in", () =>
          seedSignIn(config, { url, ...signIn, admins: getOsDeployTarget(name).admins || [] }),
        )
      : true,
    publish(true),
  ]);
  if (!seeded) await publish(false);
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

/** THE SIGN-IN a PR's body links (preview-config.ts `signInLinkOf`): the heading's link, one per
 *  app, and with the Dash one per config template into its New project sheet (preview-config.ts
 *  `templateQuickLaunches`), each the app's own sign-in naming the PR's test person
 *  `pr<N>@preview.iterate.test`, whose project `pr<N>` seedSignIn creates. The link is public and
 *  grants nothing: a reviewer signs in to the deployment as themselves, one of prd's admins
 *  (src/admin-sign-in.ts), and confirms signing the app in as the test person on the consent page,
 *  which the link pre-fills (src/consent.ts). The admin app's names nobody: an admin opens it as
 *  themselves, and so does a proxied app's (Notes, Docs), which is the app's page in `pr<N>`, whose
 *  organization seedSignIn makes the admins members of. The heading's lands in the Dash's
 *  `/projects/pr<N>` when the Dash was deployed, else on the issuer's own sign-in page. */
function signInLinks(preview: {
  url: string;
  ingressRouting: IngressRouting;
  /** the admin issuer's host, the way a reviewer signs in */
  providerHint: string;
  prNumber: string;
  apps: { name: string; url: string }[];
  changedPaths: string[];
}) {
  const project = `pr${preview.prNumber}`;
  const email = `${project}@${TEST_EMAIL_DOMAIN}`;
  const link = (app: { name: string; url: string }) =>
    signInLinkOf({
      app,
      platform: preview.url,
      ingressRouting: preview.ingressRouting,
      project,
      email,
      providerHint: preview.providerHint,
    });
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
          link: appSignInLink(next, { provider_hint: preview.providerHint, login_hint: email }),
        }))
      : [],
    email,
    project,
    // the proxied apps this deployment has, which the project serves (seedSignIn)
    proxiedApps: preview.apps.filter((app) => PROXIED_APPS.has(app.name)),
  };
}

/** Seed the PR's test person and project — created as them through the operator's bearer (`as`),
 *  the same idempotent call as e2e/support/project-host.ts `registerProject`, so the Dash link
 *  lands inside it. Then what a proxied app's link needs: a fetch route per proxied app to the
 *  deployment's own Worker (preview-config.ts `proxiedAppRoute`), and the deployment's `admins`
 *  members of the project's organization, so a reviewer signed in as themselves opens it. Each admin
 *  is found or created by email, the row their first sign-in finds. It never fails the deploy: it
 *  logs, and the section says when it failed. */
async function seedSignIn(
  config: AppConfig,
  preview: {
    url: string;
    email: string;
    project: string;
    proxiedApps: { name: string; url: string }[];
    admins: string[];
  },
) {
  const { email, project } = preview;
  const secret = config.secrets.adminBearer.exposeSecret();
  try {
    using connection = await connectIterate({
      baseUrl: preview.url,
      auth: { type: "admin-secret", secret, as: { email } },
    });
    using created = await connection.session.projects.create({ project });
    await Promise.all(
      preview.proxiedApps.map((app) =>
        created.fetchRoutes.set(app.name, proxiedAppRoute(app.name, app.url)),
      ),
    );
    const { orgId } = (await connection.session.projects.list()).find(
      (record) => record.slug === project,
    )!;
    using operator = await connectIterate({
      baseUrl: preview.url,
      auth: { type: "admin-secret", secret },
    });
    await Promise.all(
      preview.admins.map(async (admin) => {
        const user = await operator.session.users.create({ email: admin });
        await operator.session.organizations.addMember(orgId, { userId: user.id });
      }),
    );
    console.log(
      `sign-in: seeded ${email} with project ${project}, serving ${preview.proxiedApps.map((app) => app.name).join(", ") || "no proxied app"}, its members ${preview.admins.join(", ")}`,
    );
    return true;
  } catch (error) {
    console.warn(`sign-in: seeding ${email} with project ${project} failed: ${describe(error)}`);
    return false;
  }
}

/** Each suite's test telemetry identity, pinned rather than read from pnpm's ambient package name:
 *  the workspace is what its job's CI finalizer (`test-evidence.ts finalize --flake-suites specs`
 *  or `preview-e2e`, which expects that one workspace) and scripts/ci/flake-suite-summary.ts match
 *  the suite by, and each suite records its flake lines into its own `flake-records/<suite>`
 *  directory (relative to GITHUB_WORKSPACE), as the Test job's `unit` does. Only when the workflow
 *  asks for telemetry (TEST_TELEMETRY_ARTIFACT_DIR): a run from a laptop records nothing. */
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
 *  records evidence (TEST_TELEMETRY_ARTIFACT_DIR): the deployment (as `previewName`) and the
 *  version its `/version` answers with. A run against a deployment made earlier (a dispatch of
 *  `test`, `e2e` or `specs`) tests what that deploy left, not the commit this job checked out
 *  (docs/test-evidence.md#when-deploy-e2e-and-specs-are-separate-jobs). A deployment that does not
 *  answer fails no run here (the suites fail on it), and the file then has no deploymentId. A file
 *  that cannot be written fails the job before the suite: the workflows run the job's evidence
 *  steps, its telemetry completeness check among them, only once this file exists, so a suite run
 *  without it would pass with its evidence unchecked. */
async function writeDeployedTarget(name: string, apps: TestEvidenceTarget["apps"]) {
  if (!process.env.TEST_TELEMETRY_ARTIFACT_DIR) return;
  const url = previewDeploymentUrls(name).os;
  // `<deployId> <platformOrigin>` (src/worker.ts)
  const deploymentId = await fetch(`${url}/version`, { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => (response.ok ? (await response.text()).split(" ")[0] : undefined))
    .catch(() => undefined);
  try {
    const target = TestEvidenceTarget.parse({
      previewName: name,
      url,
      deploymentId: deploymentId?.trim() || undefined,
      apps,
      checkedAt: new Date().toISOString(),
    });
    const file = path.join(REPO_ROOT, testEvidencePaths.target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`);
  } catch (error) {
    throw new Error(
      `the deployed target could not be recorded (${testEvidencePaths.target}), and without it the job keeps and checks no evidence: ${describe(error)}`,
      { cause: error },
    );
  }
}

/** THE PROOF, one suite per CI job (preview-os.yml's E2E tests and Browser specs), against the
 *  live deployment in deployed-target mode: `e2e`, the vitest e2e suite, and `specs`, the root
 *  Playwright specs (specs/AGENTS.md) — the suites `pnpm e2e` and `pnpm spec` run. Each runner
 *  derives the deployed target itself (e2e/support/deployed-target.ts, from the `APP_CONFIG` in this
 *  process's environment and envs.ts `previewDeployment`): the vitest suite in its global-setup,
 *  the specs in specs/setup.ts. Every spec project runs, the app projects against this
 *  deployment's Agents, Notes, Voice, Dash and Admin apps, the Notes session specs signing out in its
 *  Dash (AGENTS_BASE_URL, NOTES_BASE_URL, VOICE_BASE_URL, DASH_BASE_URL, ADMIN_BASE_URL; their specs
 *  fail in CI without them). The job's check is the verdict. The e2e rows tagged `slow` run as asked, else as the PR's
 *  label and paths say (scripts/slow-rows.ts). Vitest gets the choice as E2E_SLOW_ROWS, which holds
 *  each row to its timeout ceiling (e2e/support/setup.ts), and the PR's number as
 *  PREVIEW_PR_NUMBER, by which the pkg.pr.new rows find the PR's own builds. */
async function runSuite(
  suite: "e2e" | "specs",
  name: string,
  prNumber: string | undefined,
  requestedSlowRows: SlowRows | undefined,
) {
  const urls = previewDeploymentUrls(name);
  const url = urls.os;
  const appUrl = (app: string) => urls.apps[app]!;
  const env: Record<string, string> =
    suite === "specs"
      ? {
          WORKER_BASE_URL: url,
          AGENTS_BASE_URL: appUrl("agents"),
          NOTES_BASE_URL: appUrl("notes"),
          VOICE_BASE_URL: appUrl("voice"),
          DASH_BASE_URL: appUrl("dash"),
          ADMIN_BASE_URL: appUrl("admin"),
        }
      : { WORKER_BASE_URL: url };
  const deployJob = process.env.PREVIEW_AWAIT_DEPLOY_JOB;
  const warm =
    deployJob && suite === "specs"
      ? // --list loads the config and every spec, and runs no global setup
        warmUp(
          "the specs' transforms",
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
        )
      : undefined;
  const failed = (error: unknown) =>
    new Error(`the ${suite} suite failed against ${url}: ${describe(error)}`);
  let tests: { args: string[]; env: Record<string, string> };
  try {
    tests = await traceOperation({ name: "Set up the suite", phase: "setup" }, async () => {
      if (suite === "specs") {
        // The headless shell alone, which headless Chromium with no `channel`
        // (playwright.config.ts) launches: a no-op when CI restored it.
        if (process.env.CI)
          await runAsync("pnpm", ["exec", "playwright", "install", "--only-shell", "chromium"], {
            cwd: REPO_ROOT,
          });
        return { args: ["spec"], env: { ...env, ...PREVIEW_SUITE_TELEMETRY.specs } };
      }
      const { slowRows, reason } = await chooseSlowRows({
        requested: requestedSlowRows,
        prNumber,
        readPullRequest: async () => {
          const [{ data: pull }, paths] = await Promise.all([
            getOctokit().rest.pulls.get(pullRequest(prNumber!)),
            changedPaths(prNumber),
          ]);
          return { labels: pull.labels.map((label) => label.name), paths };
        },
      });
      console.log(`[slow-rows] ${slowRows}: ${reason}`);
      // `e2e:run`, not `e2e`: the deployed target needs no local build.
      return {
        args: ["e2e:run", ...slowRowsTagsFilter(slowRows)],
        env: {
          ...env,
          // empty without a PR, which the rows read as none
          PREVIEW_PR_NUMBER: prNumber || "",
          E2E_SLOW_ROWS: slowRows,
          ...PREVIEW_SUITE_TELEMETRY["preview-e2e"],
        },
      };
    });
  } catch (error) {
    await warm?.stop();
    throw failed(error);
  }
  if (deployJob) {
    try {
      await traceOperation({ name: "Wait for Deploy preview", phase: "wait" }, () =>
        awaitDeployOfThisRun(deployJob),
      );
    } catch (error) {
      await warm?.stop();
      throw error;
    }
    // A warm-up still running exits beside the suite's start, not before it.
    void warm?.stop();
  }
  try {
    await writeDeployedTarget(
      name,
      // the client apps the specs run against; the vitest rows use none
      suite === "specs"
        ? ["agents", "notes", "voice", "dash", "admin"].map((app) => ({
            name: app,
            url: appUrl(app),
          }))
        : [],
    );
  } catch (error) {
    throw failed(error);
  }
  const run = { cwd: suite === "specs" ? REPO_ROOT : ROOT, env: tests.env };
  try {
    // A job that waited for its deploy has the wait's bound in its timeout, and bounds the suite
    // itself to what is left of it.
    if (deployJob) await runBounded("pnpm", tests.args, { ...run, boundMs: SUITE_BOUND_MS });
    else await runAsync("pnpm", tests.args, run);
  } catch (error) {
    throw failed(error);
  }
}

/** `command` run as deploy-helpers' `runAsync` runs it, its output inherited, but in a process
 *  group of its own, which is stopped once `boundMs` has passed: SIGTERM, which lets vitest and
 *  Playwright report what they ran and close their browsers, then SIGKILL 10 s later, and once the
 *  command has exited, SIGKILL for anything it left running. It fails either way. A SIGINT or
 *  SIGTERM this process gets while the command runs is passed on to its group, as it would reach a
 *  child in this process's own. */
function runBounded(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; boundMs: number },
) {
  const commandLine = `${command} ${args.join(" ")}`;
  console.log(`$ ${commandLine}`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
      detached: true,
    });
    const signal = (name: NodeJS.Signals) => signalGroup(child, name);
    let stopped = false;
    let killer: NodeJS.Timeout | undefined;
    const bound = setTimeout(() => {
      stopped = true;
      console.error(
        `[suite] ${commandLine} is still running after ${options.boundMs / 60_000} minutes, the suite's bound: stopping it`,
      );
      signal("SIGTERM");
      killer = setTimeout(() => signal("SIGKILL"), 10_000);
    }, options.boundMs);
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    const done = () => {
      clearTimeout(bound);
      clearTimeout(killer);
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      done();
      if (stopped) {
        signal("SIGKILL");
        reject(
          new Error(`${commandLine} ran past the suite's ${options.boundMs / 60_000} minutes`),
        );
      } else if (code === 0) resolve();
      else
        reject(
          new Error(`${commandLine} exited with ${code ?? `signal ${exitSignal || "unknown"}`}`),
        );
    });
  });
}

/** A command run only to prepare, while the preview deploys, what its suite reads before its first
 *  test: Playwright keeps what it compiles for the specs in its transform cache, in the runner's
 *  tmpdir, and checks each entry against its source's hash when the suite reads it. Nothing it runs
 *  reaches the preview or writes test evidence: the variables that make a runner write telemetry,
 *  flake records or trace markers are left out. Its output stays out of the log, and its failure is
 *  a warning, since the suite that follows reports what is wrong itself.
 *
 *  `stop()` ends it, and every process it started (its own process group), once the deploy has
 *  ended: whatever it has not compiled yet, the suite compiles anyway, so it would only take the
 *  suite's CPU. SIGTERM first, then SIGKILL 3 s later; it resolves once the group has exited. */
function warmUp(
  what: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) {
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([name]) => !/^(TEST_TELEMETRY_|FLAKE_RECORD_DIR$|CI_TRACE_ENABLED$)/.test(name),
    ),
  );
  console.log(`[warm-up] ${what}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  // the last 20 lines, shown if it fails
  const keep = (data: string) => (output = (output + data).split("\n").slice(-20).join("\n"));
  child.stdout.setEncoding("utf8").on("data", keep);
  child.stderr.setEncoding("utf8").on("data", keep);
  let stopping = false;
  let closed = false;
  const exited = traceOperation(
    { name: `Warm up ${what}`, phase: "setup" },
    () =>
      new Promise<void>((resolve) => {
        child.once("error", (error) => {
          console.warn(`[warm-up] ${what} did not start: ${error.message}`);
          resolve();
        });
        child.once("close", (code) => {
          closed = true;
          if (stopping) console.log(`[warm-up] ${what}: stopped after ${took()}`);
          else if (code === 0) console.log(`[warm-up] ${what}: done in ${took()}`);
          else
            console.warn(
              `[warm-up] ${what} exited ${code} after ${took()}; the suite runs anyway:\n${output}`,
            );
          resolve();
        });
      }),
  );
  return {
    async stop() {
      if (closed || !child.pid) return exited;
      stopping = true;
      signalGroup(child, "SIGTERM");
      const killer = setTimeout(() => signalGroup(child, "SIGKILL"), 3_000);
      await exited;
      clearTimeout(killer);
    },
  };
}

/** `name` to every process of the group `child` leads (spawned `detached`), and to none once the
 *  group has exited. */
function signalGroup(child: ChildProcess, name: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, name);
  } catch (error) {
    // ESRCH: the group has already exited
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
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

/** THE LEGACY WORKER PREVIEWS still on main on dev's workers and the former parents
 *  (preview-config.ts FORMER_PARENTS), each holding a Durable Object namespace per class of the
 *  account's 500, and the resources of `os`'s and `os-preview`'s previews
 *  (`<worker>-<preview>-<binding>`): the stale ones go (preview-sweep.ts
 *  `planLegacyWorkerPreviewSweep`). No deploy makes a Worker Preview, so this and the sweep's call
 *  go once a run logs "no Worker Previews left". */
async function deleteLegacyWorkerPreviews(cf: Cf, options: { dryRun: boolean }) {
  const osWorkers = [MAIN_ON_DEV.workerName, "os-preview"];
  const workers = [
    ...new Set([
      MAIN_ON_DEV.workerName,
      ...APPS.map((app) => app.envs.preview!.workerName),
      ...FORMER_PARENTS,
    ]),
  ];
  const listed = (
    await Promise.all(
      workers.map(async (worker) =>
        (
          await listAll<{ name: string; created_on?: string; deployed_on?: string }>(
            cf,
            `/workers/workers/${worker}/previews`,
          ).catch((error) => {
            // a worker already deleted holds no previews
            if (!isCloudflareError(error, 404, 10007)) throw error;
            return [];
          })
        ).map((preview) => ({
          worker,
          name: preview.name,
          lastDeployedAt: preview.deployed_on || preview.created_on,
        })),
      ),
    )
  ).flat();
  if (listed.length === 0) {
    console.log("no Worker Previews left");
    return { listed, failures: [] };
  }
  const plan = planLegacyWorkerPreviewSweep(Date.now(), listed);
  for (const { worker, name, verdict, reason } of plan)
    console.log(
      `  ${verdict === "stale" ? "delete" : "keep  "} legacy Worker Preview ${name} of ${worker}: ${reason}`,
    );
  if (options.dryRun) return { listed, failures: [] };
  const failures: string[] = [];
  const stale = plan.filter(({ verdict }) => verdict === "stale");
  for (const { worker, name } of stale)
    await cf(`/workers/workers/${worker}/previews/${name}?force=true`, { method: "DELETE" }).catch(
      (error) => failures.push(`${worker} preview ${name}: ${describe(error)}`),
    );
  const [kv, d1] = await Promise.all([
    listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces"),
    listAll<D1Row>(cf, "/d1/database"),
  ]);
  for (const { worker, name } of stale.filter(({ worker }) => osWorkers.includes(worker))) {
    const resource = (binding: string) => `${worker}-${name}-${binding}`;
    const removals = [
      ...kv
        .filter((row) => [resource("itx-kv"), resource("oauth-kv")].includes(row.title))
        .map((row) => () => deleteKvNamespace(cf, row)),
      ...d1.filter((row) => row.name === resource("db")).map((row) => () => deleteD1(cf, row)),
      () => deleteR2Bucket(cf, resource("files")),
      () => deleteArtifactsNamespace(cf, resource("repos")).then(() => undefined),
    ];
    for (const remove of removals)
      await remove().catch((error) => failures.push(`${worker} ${name}: ${describe(error)}`));
  }
  return { listed, failures };
}

/** How far back the sweep looks for its own open page: a page stays open, edited each night, until
 *  Cloudflare deletes what it names, and a Cloudflare escalation takes weeks. */
const PAGE_LOOKBACK_HOURS = 30 * 24;

/** The stale deployments, the legacy Worker Previews and the former parents (scripts/preview-sweep.ts),
 *  then the Durable Object namespaces no worker holds. A run on main keeps one #error-pulse page per
 *  kind of resource Cloudflare left (keepPage); a run on any other ref prints its pages. A 🧪 test run
 *  deletes nothing and posts what it would page to #ci. */
async function sweep(
  cf: Cf,
  options: { dryRun: boolean; testRun: boolean; onMain: boolean; jobUrl: string | undefined },
) {
  const { dryRun, testRun, jobUrl } = options;
  const [members, namespaces] = await Promise.all([
    listAccountMembers(cf),
    listAll<SweptNamespace>(cf, "/workers/durable_objects/namespaces"),
  ]);
  const suffixes = memberSuffixes();
  const deployments = groupPreviewDeployments(members, suffixes);
  const workers = members.filter(({ kind }) => kind === "worker").map(({ name }) => name);
  console.log(
    `${deployments.length} deployment(s), ${workers.length} worker(s) and ${namespaces.length} Durable Object namespace(s) on the account`,
  );
  const pullRequestStates = new Map<number, PullRequestState>();
  for (const number of new Set(
    deployments
      .map((deployment) => previewPullRequestNumber(deployment.prefix))
      .filter((number) => number !== undefined),
  ))
    pullRequestStates.set(number, await pullRequestState(number));
  const plan = planPreviewSweep({ now: Date.now(), deployments, pullRequestStates });
  for (const { deployment, verdict, reason } of plan)
    console.log(`  ${verdict === "stale" ? "delete" : "keep  "} ${deployment.name}: ${reason}`);
  const stale = plan
    .filter(({ verdict }) => verdict === "stale")
    .map(({ deployment }) => deployment);
  const legacy = await deleteLegacyWorkerPreviews(cf, { dryRun });
  const previewsLeft = new Map<string, number>();
  for (const { worker } of legacy.listed)
    previewsLeft.set(worker, (previewsLeft.get(worker) || 0) + 1);
  const formerParents = planFormerParents({
    workers,
    deployedWorkerNames: accountWorkerNames(),
    accountResourceNames: accountResourceNames(),
    resources: members.filter(({ kind }) => kind !== "worker"),
    suffixes,
    previewsLeft,
  });
  for (const { name, worker, resources, verdict, reason } of formerParents)
    console.log(
      `  ${verdict === "stale" ? "delete" : "keep  "} former parent ${name} (${worker ? "its worker" : "no worker"}, ${resources.length} resources: ${resources.map((resource) => resource.name).join(", ") || "none"}): ${reason}`,
    );
  // a former parent is deleted like a deployment: its worker, if any is left, then its resources
  const staleFormerParents = formerParents
    .filter(({ verdict }) => verdict === "stale")
    .map(({ name, worker, resources }) => ({
      name,
      prefix: name,
      members: [...(worker ? [{ kind: "worker" as const, name, id: name }] : []), ...resources],
    }));
  const unmapped = unmappedWorkers(workers, accountWorkerNames(), deployments);
  if (unmapped.length > 0)
    console.log(
      `  keep   ${unmapped.length} worker(s) envs.ts does not name, for a person to judge: ${unmapped.join(", ")}`,
    );
  // What the account's Durable Object namespace count (Cloudflare's limit is per account) loses.
  const deletedWorkers = new Set(
    [...stale, ...staleFormerParents].flatMap((group) =>
      group.members.filter(({ kind }) => kind === "worker").map(({ name }) => name),
    ),
  );
  const freedNamespaceIds = new Set(
    namespaces
      .filter((namespace) => deletedWorkers.has(namespace.script || ""))
      .map(({ id }) => id),
  );
  const workerless = workerlessNamespaces(namespaces, workers);
  if (workerless.length > 0)
    console.log(
      `  ${workerless.length} Durable Object namespace(s) whose worker is gone, paged if still listed once the run is done: ${workerless.map(({ name }) => name).join(", ")}`,
    );
  console.log(
    `plan: ${stale.length} stale deployment(s) of ${plan.length}; ${staleFormerParents.length} former parent(s); ${freedNamespaceIds.size} of the account's ${namespaces.length} Durable Object namespaces go with them; ${unmapped.length} unmapped worker(s) kept`,
  );
  if (testRun) {
    // Only the workerless kind can be judged without deleting: a stuck namespace is one a delete
    // was refused.
    const text =
      workerless.length > 0
        ? renderWorkerlessNamespacesPage(workerless, { jobUrl, testRun })
        : `🧪 TEST RUN — preview sweep: nothing to page; ${stale.length} stale deployment(s) and ${staleFormerParents.length} former parent(s) to delete${jobUrl ? ` · <${jobUrl}|run>` : ""}`;
    console.log(text);
    await getSlackClient().chat.postMessage({ channel: slackChannelIds["#ci"], text });
    return;
  }
  if (dryRun) return;
  const { failures, stuckNamespaces } = await deletePreviewDeployments(cf, [
    ...stale,
    ...staleFormerParents,
  ]);
  failures.push(...legacy.failures);
  // Once the deletes are done, each namespace they took should be gone from the listing. One still
  // listed after deletes that all succeeded is Cloudflare's: a warn now, and the next run's page,
  // which finds it workerless (so a namespace Cloudflare drops a moment late pages no one).
  const listedAfter = await listAll<SweptNamespace>(cf, "/workers/durable_objects/namespaces");
  const outlived = listedAfter.filter(({ id }) => freedNamespaceIds.has(id));
  if (failures.length === 0 && outlived.length > 0)
    console.warn({
      event: "preview.platform-failure-durable-object-namespace-delete",
      namespaces: outlived.map(({ name }) => name),
    });
  const listedIds = new Set(listedAfter.map(({ id }) => id));
  const stillWorkerless = workerless.filter(({ id }) => listedIds.has(id));
  // The run is red only when the sweep could not act. A scheduled run reports on main's head
  // commit, where red reads as "this commit broke", so what Cloudflare left is a page instead (the
  // rule scripts/ci/prd-fault-alarm.ts follows); a page that could not be kept is a failure. A night
  // may not reach a stuck namespace, so its page keeps each one it named until reads confirm it
  // gone; the account's listing after the deletes judges the workerless ones.
  const incidents = [
    {
      marker: STUCK_ARTIFACTS_PAGE_MARKER,
      render: async (openText: string | undefined) => {
        const stuck = [
          ...stuckNamespaces,
          ...(openText
            ? await stuckNamespacesStillThere(
                cf,
                openText,
                stuckNamespaces.map(({ namespace }) => namespace),
              )
            : []),
        ];
        return stuck.length > 0
          ? renderStuckArtifactsNamespacesPage(stuck, { jobUrl, testRun })
          : undefined;
      },
    },
    {
      marker: WORKERLESS_PAGE_MARKER,
      render: async () =>
        stillWorkerless.length > 0
          ? renderWorkerlessNamespacesPage(stillWorkerless, { jobUrl, testRun })
          : undefined,
    },
  ];
  const slack = options.onMain ? getSlackClient() : undefined;
  for (const { marker, render } of incidents) {
    if (!slack) {
      const text = await render(undefined);
      if (text) console.log(text);
      continue;
    }
    await keepPage(slack, {
      marker,
      sinceHours: PAGE_LOOKBACK_HOURS,
      now: new Date(),
      render: async (openText) => {
        const text = await render(openText);
        if (text) console.log(text);
        return text;
      },
      why: "Cloudflare deleted them",
    })
      .then((step) => console.log(`#error-pulse page "${marker}": ${step}`))
      .catch((error) => failures.push(`keeping the #error-pulse page: ${describe(error)}`));
  }
  if (failures.length > 0) throw new Error(`sweep failures:\n  ${failures.join("\n  ")}`);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

type PreviewOptions = {
  /** the pull request's number: its deployments are `pr<n>-<sha7>` */
  pr?: string;
  /** the prefix's name, for a deployment with no PR (`exp-<you>`, CI's own `main`) */
  name?: string;
  /** the apps on top: all (default: a PR's, a CI workflow's) or none (a soak of apps/os alone) */
  apps?: "all" | "none";
  /** e2e: which rows tagged `slow` run — run, skip or only (default: as the PR's paths and label
   *  say, scripts/slow-rows.ts) */
  slowRows?: "run" | "skip" | "only";
  /** print the plan instead of acting */
  dryRun?: boolean;
  /** sweep: post what it would page to #ci as a 🧪 TEST RUN, and delete nothing */
  testRun?: boolean;
};

/** A fresh set of plain workers per tested commit: `pnpm preview <command> [flags]`. */
export default class Preview {
  /** build apps/os for this commit's deployment and name the config it wrote */
  async config(options: PreviewOptions = {}) {
    await main("config", options);
  }
  /** this commit's deployment: apps/os, the apps on top, the PR body's section */
  async deploy(options: PreviewOptions = {}) {
    await main("deploy", options);
  }
  /** the vitest e2e suite against a deployment (see `main`: which one it tests) */
  async e2e(options: PreviewOptions = {}) {
    await main("e2e", options);
  }
  /** the Playwright specs against a deployment (see `main`: which one it tests) */
  async specs(options: PreviewOptions = {}) {
    await main("specs", options);
  }
  /** delete the prefix's deployments PREVIEW_DEPLOYMENT supersedes */
  async cleanupSuperseded(options: PreviewOptions = {}) {
    await main("cleanup-superseded", options);
  }
  /** every deployment of the prefix: its workers, KV, R2 bucket, D1 and Artifacts namespace */
  async delete(options: PreviewOptions = {}) {
    await main("delete", options);
  }
  /** the stale deployments (scripts/preview-sweep.ts) and the legacy Worker Previews */
  async sweep(options: PreviewOptions = {}) {
    await main("sweep", options);
  }
  /** main on the dev/preview account, from this checkout, in place */
  async deployParents(options: PreviewOptions = {}) {
    await main("deploy-parents", options);
  }
  /** main on dev's own data erased, then main on dev deployed again */
  async resetParent(options: PreviewOptions = {}) {
    await main("reset-parent", options);
  }
}

async function main(command: Command, options: PreviewOptions) {
  const dryRun = options.dryRun || false;
  const pr = options.pr;
  if (command === "sweep")
    return sweep((await accountContext()).cf, {
      dryRun: dryRun || Boolean(options.testRun),
      testRun: Boolean(options.testRun),
      onMain: process.env.GITHUB_REF === "refs/heads/main",
      jobUrl: process.env.DEPOT_JOB_URL,
    });
  if (command === "deploy-parents") return deployParents(await accountContext());
  if (command === "reset-parent") return resetParent({ dryRun });
  if (command === "cleanup-superseded") {
    const current = process.env.PREVIEW_DEPLOYMENT;
    if (!current)
      throw new Error("cleanup-superseded needs PREVIEW_DEPLOYMENT, the deployment the run made");
    return cleanupSuperseded((await accountContext()).cf, current, { dryRun });
  }
  const prefix = resolvePreviewPrefix({ name: options.name, prNumber: pr });
  if (command === "delete") return deletePrefix((await accountContext()).cf, prefix, { dryRun });
  if (command === "e2e" || command === "specs")
    return runSuite(
      command,
      // beside its run's deploy, the deployment of the commit both checked out
      // (preview-tested-commit.ts): known before it exists
      process.env.PREVIEW_AWAIT_DEPLOY_JOB
        ? previewDeploymentName(prefix, checkedOutCommit())
        : await deploymentToTest(prefix),
      pr,
      options.slowRows,
    );
  const name = previewDeploymentName(prefix, checkedOutCommit());
  const urls = previewDeploymentUrls(name);
  console.log(`deployment ${name} → ${urls.os}`);
  if (command === "config") {
    await buildOs(name);
    console.log(`wrote ${findBuiltWranglerConfig(ROOT)}`);
    return;
  }
  const apps = options.apps === "none" ? [] : APPS;
  if (dryRun) {
    for (const app of apps) console.log(`  apps/${app.name} → ${urls.apps[app.name]}`);
    return;
  }
  // the name the suites and the cleanup job test and keep (preview-os.yml, main-os-e2e.yml)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deployment=${name}\n`);
  return deployPreview(await accountContext(), name, pr, apps);
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "preview" }).run({ formatError: describe });
