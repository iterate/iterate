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
//                       specs against a deployment: PREVIEW_DEPLOYMENT, else the prefix's newest
//   cleanup-superseded  delete the prefix's deployments PREVIEW_DEPLOYMENT supersedes
//   delete              every deployment of a prefix: a closed PR's (preview-delete.yml)
//   sweep               the stale deployments (preview-sweep.ts), nightly (preview-sweep.yml)
//   deploy-parents      main on the dev/preview account, redeployed in place (preview-parents.yml)
//   reset-parent        main on dev's data erased, then deployed again (preview-sweep.yml)
// `--dry-run` prints the plan.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import { buildStartApp, type StartApp } from "../../../scripts/lib/start-app.ts";
import { createOctokit, getOctokit, getRepo } from "../../../scripts/ci/github.ts";
import { getSlackClient, slackChannelIds } from "../../../scripts/ci/slack.ts";
import { traceOperation } from "../../../scripts/ci/tracing/tracing.ts";
import { parseAppConfig, type AppConfig } from "../src/app-config.ts";
import { mintTestLink, TEST_LINK_PATH, testLinkIdentityOf } from "../src/test-link.ts";
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
  type ArtifactsNamespaceRow,
  type Cf,
  type StuckArtifactsNamespace,
} from "./preview-artifacts.ts";
import {
  APPS,
  assertFreshInstall,
  configTemplateNames,
  foldPreviousPreviewSection,
  MAIN_ON_DEV,
  previewDeploymentName,
  previewDeploymentUrls,
  previewPullRequestNumber,
  renderPullRequestSection,
  resolvePreviewPrefix,
  splicePullRequestBody,
  templateQuickLaunches,
} from "./preview-config.ts";
import {
  groupPreviewDeployments,
  newestPreviewDeployment,
  planPreviewSweep,
  planSupersededCleanup,
  previewMemberSuffixes,
  type PreviewDeploymentListing,
  type PreviewMember,
  type PullRequestState,
} from "./preview-sweep.ts";
import { chooseSlowRows, SlowRows, slowRowsTagsFilter } from "./slow-rows.ts";

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
/** The apps on top: every one (a PR's, a CI workflow's), or none (a soak of apps/os alone). */
const AppsMode = z.enum(["all", "none"]);
type AppsMode = z.infer<typeof AppsMode>;

/** Main on dev's Doppler config (envs.ts `OS_DOPPLER_PROJECT`, config `preview`), downloaded — the
 *  Cloudflare credentials for the dev/preview account and the two secrets every apps/os deploy
 *  there ships — the way ensure-resources and erase-data resolve theirs. Refuses a Doppler account
 *  that is not the dev/preview one. */
const accountContext = () =>
  resolveEnvContext({ envs: osEnvs, dopplerProject: OS_DOPPLER_PROJECT, env: "preview" });

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

/** Read, splice, write, read back: the PR body has no conditional update, so a person editing the
 *  description in the same seconds could lose one write or the other. Reading it back and
 *  re-splicing onto whatever is there now converges on both edits within a few rounds. `what` names
 *  the write in the log: the fold of the previous section, or the section. Every PATCH goes out
 *  once, straight after its read: a 5xx is not asked again with a body read seconds earlier, the
 *  next round reads anew. */
async function writePullRequestBody(
  prNumber: string,
  what: string,
  splice: (body: string) => string,
) {
  const github = getOctokit();
  const readBody = async () => (await github.rest.pulls.get(pullRequest(prNumber))).data.body || "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await readBody();
    const body = splice(before);
    if (body === before) return console.log(`PR #${prNumber}'s body already carries ${what}`);
    const patchError = await github.rest.pulls
      .update({ ...pullRequest(prNumber), body, request: { askOnce: true } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (patchError) {
      console.warn(`${describe(patchError)}; reading the body again`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const after = await readBody();
    if (splice(after) === after)
      return console.log(`wrote ${what} into the body of PR #${prNumber}`);
    console.warn(
      `PR #${prNumber}'s body changed under the write (attempt ${attempt}); re-splicing`,
    );
  }
  throw new Error(`could not write ${what} into PR #${prNumber}'s body: it kept changing`);
}

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

/** Every worker, KV namespace, R2 bucket, D1 and Artifacts namespace on the account that belongs to
 *  a per-commit deployment, grouped by deployment (preview-sweep.ts `groupPreviewDeployments`). */
async function listPreviewDeployments(cf: Cf) {
  const suffixes = previewMemberSuffixes(
    readWranglerBase().kv_namespaces.map(({ binding }: { binding: string }) => binding),
  );
  // R2 pages by cursor, which the API client does not hand back: one page of the API's ceiling,
  // narrowed to a deployment's bucket suffix, and a full one refused.
  const [scripts, kv, { buckets }, d1, artifacts] = await Promise.all([
    cf<{ id: string; created_on?: string }[]>("/workers/scripts"),
    listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces"),
    cf<{ buckets: { name: string; creation_date?: string }[] }>(
      `/r2/buckets?name_contains=-${suffixes.r2[0]}&per_page=1000`,
    ),
    listAll<D1Row>(cf, "/d1/database"),
    listAll<ArtifactsNamespaceRow>(cf, "/artifacts/namespaces"),
  ]);
  if (buckets.length >= 1000)
    throw new Error("1000 or more R2 buckets: the listing may be cut off");
  const members: PreviewMember[] = [
    ...scripts.map((row) => ({
      kind: "worker" as const,
      name: row.id,
      id: row.id,
      createdAt: row.created_on,
    })),
    ...kv.map((row) => ({ kind: "kv" as const, name: row.title, id: row.id })),
    ...buckets.map((row) => ({
      kind: "r2" as const,
      name: row.name,
      id: row.name,
      createdAt: row.creation_date,
    })),
    ...d1.map((row) => ({
      kind: "d1" as const,
      name: row.name,
      id: row.uuid,
      createdAt: row.created_at,
    })),
    ...artifacts.map((row) => ({
      kind: "artifacts" as const,
      name: row.namespace,
      id: row.namespace,
      createdAt: row.created_at,
    })),
  ];
  return groupPreviewDeployments(members, suffixes);
}

/** A deployment's workers first, so nothing writes to what goes next, then its KV, R2 bucket, D1
 *  and Artifacts namespace; each member one at a time settles before any failure is named. One
 *  already gone is the expected case. Resolves to its Artifacts namespace when Cloudflare will not
 *  delete it (StuckArtifactsNamespace): the rest still goes, and the nightly sweep retries and
 *  pages it. */
async function deletePreviewDeployment(cf: Cf, deployment: PreviewDeploymentListing) {
  const failures: string[] = [];
  let stuck: StuckArtifactsNamespace | undefined;
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
      if (member.kind === "d1") {
        await cf(`/d1/database/${member.id}`, { method: "DELETE" });
        return console.log(`deleted D1 ${member.name}`);
      }
      stuck = await deleteArtifactsNamespace(cf, member.name);
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
      (stuck) => {
        if (stuck) stuckNamespaces.push(stuck);
      },
      (error) => failures.push(describe(error)),
    );
  }
  return { failures, stuckNamespaces };
}

/** THE PREFIX'S DEPLOYMENTS THIS ONE SUPERSEDES (preview-sweep.ts `planSupersededCleanup`): each
 *  run's `Clean up superseded` job, once its own deployment is ready. Never the run's verdict: the
 *  job does not gate the checks, and what it leaves the next run's cleanup or the sweep takes. */
async function cleanupSuperseded(cf: Cf, name: string, options: { dryRun: boolean }) {
  const superseded = planSupersededCleanup(await listPreviewDeployments(cf), name);
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

/** The deployment a suite tests: the one the run just deployed (PREVIEW_DEPLOYMENT, the deploy
 *  job's output), else — a test-only dispatch, a laptop — the prefix's newest. */
async function deploymentToTest(prefix: string) {
  if (process.env.PREVIEW_DEPLOYMENT) return process.env.PREVIEW_DEPLOYMENT;
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
  await smoke(`${url}/healthz`, (status) => status === 200, `apps/${app.name} health`);
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
          writePullRequestBody(prNumber, "the folded previous section", foldPreviousPreviewSection),
        ).catch((error: unknown) =>
          console.warn(`could not fold the previous section: ${describe(error)}`),
        )
      : Promise.resolve();
  await deployPreviewSteps(ctx, name, prNumber, apps, folded);
}

/** The version apps/os's `/version` names (`<versionId> <platformOrigin>`, src/worker.ts): on a
 *  brand-new worker, the one this deploy uploaded. */
async function deployedVersion(url: string) {
  const response = await fetch(`${url}/version`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}/version answered ${response.status}`);
  return (await response.text()).split(" ")[0]!.trim();
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
  const versionId = await deployedVersion(url);
  const config = parseAppConfig(collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]));
  // `/version` answering is not the deployment answering: a brand-new worker's Durable Objects
  // answer `internal error; reference = …` for seconds after it (19 of 20 brand-new Worker Previews
  // on 2026-09-24, for 6–27 s; preview-readiness.ts). Nothing is handed on — the PR body's links,
  // the sign-in seed, the e2e job — until five rounds of eight in a row answer in full on this
  // version. One that does not within 150 s fails the deploy, naming what it answered.
  await traceOperation("Readiness gate", () =>
    awaitPreviewReady(url, {
      adminSecret: config.secrets.adminBearer.exposeSecret(),
      version: versionId,
      width: 8,
      consecutive: 5,
      deadlineMs: 150_000,
    }),
  );
  console.log(`\ndeployment ${name}: ${url}`);
  const signIn = prNumber
    ? await signInLinks(config, {
        url,
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
      writePullRequestBody(prNumber, "the preview section", (body) =>
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

/** THE ONE-CLICK SIGN-IN a PR's body links (src/test-link.ts): the heading's link, one per app,
 *  and with the Dash one per config template into its New project sheet (preview-config.ts
 *  `templateQuickLaunches`), all as the PR's test person `pr<N>@preview.iterate.test`, whose
 *  project `pr<N>` seedSignIn creates. Each link is signed with the preview's own key for this
 *  preview's origin, expires in 14 days (every push mints a fresh one) and pre-approves this run's
 *  app previews (consent.ts: no Allow page). The heading's lands in the Dash's `/projects/pr<N>`
 *  when the Dash was previewed, else on the issuer's own `/login` ("Signed in as"). */
async function signInLinks(
  config: AppConfig,
  preview: {
    url: string;
    prNumber: string;
    apps: { name: string; url: string }[];
    changedPaths: string[];
  },
) {
  const { email, project } = testLinkIdentityOf(preview.prNumber);
  const clients = preview.apps.map((app) => new URL(app.url).origin);
  const link = async (next: string) =>
    `${preview.url}${TEST_LINK_PATH}?${new URLSearchParams({
      t: await mintTestLink({
        key: config.secrets.key.exposeSecret(),
        audience: preview.url,
        email,
        next,
        clients,
        expiresAt: Date.now() + 14 * 24 * 3600_000,
      }),
    })}`;
  const landing = (app: { name: string; url: string }) =>
    app.name === "dash" ? `${app.url}/projects/${project}` : app.url;
  const dash = preview.apps.find((app) => app.name === "dash");
  const heading = await link(dash ? landing(dash) : `${preview.url}/login`);
  const apps = Object.fromEntries(
    await Promise.all(preview.apps.map(async (app) => [app.name, await link(landing(app))])),
  );
  const templates = dash
    ? await Promise.all(
        templateQuickLaunches({
          dashUrl: dash.url,
          templates: configTemplateNames(REPO_ROOT),
          changedPaths: preview.changedPaths,
          // the PR head (the workflow's), which GitHub keeps; a laptop's checkout is its head
          headSha: process.env.PREVIEW_HEAD_SHA || checkedOutCommit(),
        }).map(async ({ name, fromHead, next }) => ({ name, fromHead, link: await link(next) })),
      )
    : [];
  return { heading, apps, templates, email, project };
}

/** Seed the PR's test person and project — created as them through the operator's bearer (`as`),
 *  the same idempotent call as e2e/support/project-host.ts `registerProject`, so the Dash link
 *  lands inside it — then smoke the heading's link. Neither ever fails the deploy: they log, and
 *  the section says when the seed failed. */
async function seedSignIn(
  config: AppConfig,
  preview: { url: string; email: string; project: string; heading: string },
) {
  const { email, project } = preview;
  let seeded = false;
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
    seeded = true;
    console.log(`sign-in: seeded ${email} with project ${project}`);
  } catch (error) {
    console.warn(`sign-in: seeding ${email} with project ${project} failed: ${describe(error)}`);
  }
  const smoke = await fetch(preview.heading, { redirect: "manual" }).catch(
    (error: unknown) => error,
  );
  if (smoke instanceof Response && smoke.status === 302 && smoke.headers.has("set-cookie"))
    console.log(`sign-in: the heading link signs in (302 to ${smoke.headers.get("location")})`);
  else
    console.warn(
      `sign-in: the heading link did not sign in: ${smoke instanceof Response ? `${smoke.status} ${await smoke.text()}` : describe(smoke)}`,
    );
  return seeded;
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
 *  records evidence (TEST_TELEMETRY_ARTIFACT_DIR): the deployment (as `previewName`) and the
 *  version its `/version` answers with. A run against a deployment made earlier (a dispatch of
 *  `test`, `e2e` or `specs`) tests what that deploy left, not the commit this job checked out
 *  (docs/test-evidence.md#when-deploy-e2e-and-specs-are-separate-jobs). It never fails the run: a
 *  deployment that does not answer fails the suites, and the file then has no deploymentId. */
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
    console.warn(`the deployed target was not recorded: ${describe(error)}`);
  }
}

/** THE PROOF, one suite per CI job (preview-os.yml's E2E tests and Browser specs), against the
 *  live deployment in deployed-target mode: `e2e`, the vitest e2e suite, and `specs`, the root
 *  Playwright specs (specs/AGENTS.md) — the suites `pnpm e2e` and `pnpm spec` run. Each runner
 *  derives the deployed target itself (e2e/support/deployed-target.ts, from the `APP_CONFIG` in this
 *  process's environment and envs.ts `previewDeployment`): the vitest suite in its global-setup,
 *  the specs in specs/setup.ts. Every spec project runs, the notes and voice projects against this
 *  deployment's Notes, Voice, Dash and Admin apps, the Notes session specs signing out in its Dash
 *  (NOTES_BASE_URL, VOICE_BASE_URL, DASH_BASE_URL, ADMIN_BASE_URL; their specs fail in CI without
 *  them). The job's check is the verdict. The e2e rows tagged `slow` run as asked, else as the PR's
 *  label and paths say (scripts/slow-rows.ts). Vitest gets the choice as E2E_SLOW_ROWS, which holds
 *  each row to its timeout ceiling (e2e/support/setup.ts). */
async function runSuite(
  suite: "e2e" | "specs",
  name: string,
  prNumber: string | undefined,
  requestedSlowRows: SlowRows | undefined,
) {
  const urls = previewDeploymentUrls(name);
  const url = urls.os;
  const env = { WORKER_BASE_URL: url, DEMO_BASE_URL: url };
  const appUrl = (app: string) => urls.apps[app]!;
  await writeDeployedTarget(
    name,
    // the client apps the specs run against; the vitest rows use none
    suite === "specs"
      ? ["notes", "voice", "dash", "admin"].map((name) => ({ name, url: appUrl(name) }))
      : [],
  );
  try {
    if (suite === "e2e") {
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
      await runAsync("pnpm", ["e2e:run", ...slowRowsTagsFilter(slowRows)], {
        cwd: ROOT,
        env: { ...env, E2E_SLOW_ROWS: slowRows, ...PREVIEW_SUITE_TELEMETRY["preview-e2e"] },
      });
    } else {
      if (process.env.CI)
        await runAsync("pnpm", ["exec", "playwright", "install", "chromium"], {
          cwd: REPO_ROOT,
        });
      await runAsync("pnpm", ["spec"], {
        cwd: REPO_ROOT,
        env: {
          ...env,
          NOTES_BASE_URL: appUrl("notes"),
          VOICE_BASE_URL: appUrl("voice"),
          DASH_BASE_URL: appUrl("dash"),
          ADMIN_BASE_URL: appUrl("admin"),
          ...PREVIEW_SUITE_TELEMETRY.specs,
        },
      });
    }
  } catch (error) {
    throw new Error(`the ${suite} suite failed against ${url}: ${describe(error)}`);
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

/** LEGACY, from before per-commit deployments (2026-09-25): the Worker Previews of main on dev's
 *  workers that each PR used to get, and apps/os's previews' resources (`os-<preview>-<binding>`).
 *  Every run finds fewer; delete this, and the sweep's call, once one logs "no Worker Previews
 *  left". */
async function deleteLegacyWorkerPreviews(cf: Cf, options: { dryRun: boolean }) {
  const failures: string[] = [];
  const osPreviews: string[] = [];
  for (const worker of [
    MAIN_ON_DEV.workerName,
    ...APPS.map((app) => app.envs.preview!.workerName),
  ]) {
    const previews = await listAll<{ name: string }>(cf, `/workers/workers/${worker}/previews`);
    for (const { name } of previews) {
      if (worker === MAIN_ON_DEV.workerName) osPreviews.push(name);
      console.log(
        `  ${options.dryRun ? "would delete" : "delete"} legacy Worker Preview ${name} of ${worker}`,
      );
      if (options.dryRun) continue;
      await cf(`/workers/workers/${worker}/previews/${name}?force=true`, {
        method: "DELETE",
      }).catch((error) => failures.push(`${worker} preview ${name}: ${describe(error)}`));
    }
  }
  if (osPreviews.length === 0 && failures.length === 0) console.log("no Worker Previews left");
  const legacyName = (preview: string, binding: string) =>
    `${MAIN_ON_DEV.workerName}-${preview}-${binding}`;
  const [kv, d1] = await Promise.all([
    listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces"),
    listAll<D1Row>(cf, "/d1/database"),
  ]);
  for (const preview of osPreviews) {
    if (options.dryRun) continue;
    const removals = [
      ...kv
        .filter((row) =>
          [legacyName(preview, "itx-kv"), legacyName(preview, "oauth-kv")].includes(row.title),
        )
        .map((row) => () => deleteKvNamespace(cf, row)),
      ...d1
        .filter((row) => row.name === legacyName(preview, "db"))
        .map(
          (row) => () => cf(`/d1/database/${row.uuid}`, { method: "DELETE" }).then(() => undefined),
        ),
      () => deleteR2Bucket(cf, legacyName(preview, "files")),
      () => deleteArtifactsNamespace(cf, legacyName(preview, "repos")).then(() => undefined),
    ];
    for (const remove of removals)
      await remove().catch((error) => failures.push(`${preview}: ${describe(error)}`));
  }
  return failures;
}

/** The stale deployments (scripts/preview-sweep.ts), then the legacy Worker Previews. */
async function sweep(cf: Cf, options: { dryRun: boolean; jobUrl: string | undefined }) {
  const { dryRun } = options;
  const deployments = await listPreviewDeployments(cf);
  console.log(`${deployments.length} deployment(s) on the account`);
  const pullRequestStates = new Map<number, PullRequestState>();
  for (const number of new Set(
    deployments
      .map((deployment) => previewPullRequestNumber(deployment.prefix))
      .filter((number) => number !== undefined),
  ))
    pullRequestStates.set(number, await pullRequestState(number));
  const plan = planPreviewSweep({
    now: Date.now(),
    deployments,
    pullRequestStates,
    openPullRequestBranches: await openPullRequestBranches(),
  });
  for (const { deployment, verdict, reason } of plan)
    console.log(`  ${verdict === "stale" ? "delete" : "keep  "} ${deployment.name}: ${reason}`);
  const stale = plan
    .filter(({ verdict }) => verdict === "stale")
    .map(({ deployment }) => deployment);
  console.log(`plan: ${stale.length} stale deployment(s) of ${plan.length}`);
  const legacyFailures = await deleteLegacyWorkerPreviews(cf, { dryRun });
  if (dryRun) return;
  const { failures, stuckNamespaces } = await deletePreviewDeployments(cf, stale);
  failures.push(...legacyFailures);
  // The run is red only when the sweep could not act. A scheduled run reports on main's head
  // commit, where red reads as "this commit broke", so Cloudflare's refusal is a page instead
  // (the rule scripts/ci/prd-fault-alarm.ts follows); a page that could not be posted is a failure.
  if (stuckNamespaces.length > 0) {
    const text = renderStuckArtifactsNamespacesPage(stuckNamespaces, options.jobUrl);
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
  /** the prefix's name, for a run without a PR number (else PREVIEW_NAME) */
  name?: string;
  /** the apps on top: all (default, else PREVIEW_APPS) or none */
  apps?: "all" | "none";
  /** e2e: which rows tagged `slow` run — run, skip or only (else E2E_SLOW_ROWS) */
  slowRows?: "run" | "skip" | "only";
  /** print the plan instead of acting */
  dryRun?: boolean;
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
  /** the vitest e2e suite against a deployment (PREVIEW_DEPLOYMENT, else the prefix's newest) */
  async e2e(options: PreviewOptions = {}) {
    await main("e2e", options);
  }
  /** the Playwright specs against a deployment (PREVIEW_DEPLOYMENT, else the prefix's newest) */
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
  const pr = options.pr || process.env.PREVIEW_PR_NUMBER;
  if (command === "sweep")
    return sweep((await accountContext()).cf, { dryRun, jobUrl: process.env.DEPOT_JOB_URL });
  if (command === "deploy-parents") return deployParents(await accountContext());
  if (command === "reset-parent") return resetParent({ dryRun });
  if (command === "cleanup-superseded") {
    const current = process.env.PREVIEW_DEPLOYMENT;
    if (!current)
      throw new Error("cleanup-superseded needs PREVIEW_DEPLOYMENT, the deployment the run made");
    return cleanupSuperseded((await accountContext()).cf, current, { dryRun });
  }
  const prefix = resolvePreviewPrefix({
    name: options.name || process.env.PREVIEW_NAME,
    prNumber: pr,
  });
  if (command === "delete") return deletePrefix((await accountContext()).cf, prefix, { dryRun });
  if (command === "e2e" || command === "specs")
    return runSuite(
      command,
      await deploymentToTest(prefix),
      pr,
      options.slowRows || SlowRows.optional().parse(process.env.E2E_SLOW_ROWS || undefined),
    );
  const name = previewDeploymentName(prefix, checkedOutCommit());
  const urls = previewDeploymentUrls(name);
  console.log(`deployment ${name} → ${urls.os}`);
  if (command === "config") {
    await buildOs(name);
    console.log(`wrote ${findBuiltWranglerConfig(ROOT)}`);
    return;
  }
  const apps =
    AppsMode.parse(options.apps || process.env.PREVIEW_APPS || "all") === "all" ? APPS : [];
  if (dryRun) {
    for (const app of apps) console.log(`  apps/${app.name} → ${urls.apps[app.name]}`);
    return;
  }
  // the name the suites and the cleanup job test and keep (preview-os.yml, main-os-e2e.yml)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deployment=${name}\n`);
  return deployPreview(await accountContext(), name, pr, apps);
}

if (process.argv[1]?.endsWith("preview.ts"))
  void createCli({ ...import.meta, name: "preview" }).run({ formatError: describe });
