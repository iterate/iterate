// scripts/preview.ts — one Worker Preview per pull request of the one worker, the cloudflare-os recipe
// (their scripts/preview/preview.ts: eighteen workers in three tiers collapsed to one). The effects
// half; the pure half — naming, the PR body's section, the preview's wrangler config — is
// scripts/preview-config.ts (preview.test.ts). Commands: config (build and write preview config),
// deploy (build, the Artifacts namespace, the secrets, `wrangler preview`, the PR body and its
// status line), e2e (vitest and Playwright against the live preview; the status line), reset (delete, then deploy), delete (the
// preview, its Artifacts namespace, KV namespaces and R2 bucket, plus any leftover D1, the apps on
// top), delete-superseded (every `main-<sha>`, or `latency-<sha>`, preview but this one: main's
// cancelled runs'), sweep
// (the stale previews and the resources that outlived theirs — the rules are
// scripts/preview-sweep.ts). `--dry-run` prints the plan.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import { z } from "zod";
import { OS_DOPPLER_PROJECT, osEnvs, type OsEnv } from "../../../envs.ts";
import {
  collectSecrets,
  runAsync,
  smoke,
  smokeResponse,
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
import { getSlackClient, slackChannelIds } from "../../../scripts/ci/slack.ts";
import { traceOperation } from "../../../scripts/ci/tracing/tracing.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { mintTestLink, TEST_LINK_PATH, testLinkIdentityOf } from "../src/test-link.ts";
import { buildOs } from "./build.ts";
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
  APPS,
  appPreviewOrigins,
  appPreviewUrl,
  assertFreshInstall,
  changedApps,
  configTemplateNames,
  lastLines,
  PREVIEW_CONFIG_NAME,
  PREVIEW_PARENT,
  isDurableObjectClassNotExportedError,
  previewPullRequestNumber,
  previewResourceName,
  previewResourceSuffixes,
  previewUrl,
  renderPullRequestSection,
  resolvePreviewName,
  splicePreviewStatus,
  splicePullRequestBody,
  templateQuickLaunches,
  writePreviewWranglerConfig,
  type PreviewStatus,
} from "./preview-config.ts";
import {
  planPreviewSweep,
  previewNameOfSweptResource,
  supersededMainPreviews,
  type PullRequestState,
  type SweptResource,
} from "./preview-sweep.ts";

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
  "reset",
  "delete",
  "delete-superseded",
  "sweep",
]);
type Command = z.infer<typeof Command>;
/** The apps on top: every one by default, none, or (auto) the ones whose paths this PR changes. */
const AppsMode = z.enum(["all", "auto", "none"]);
type AppsMode = z.infer<typeof AppsMode>;
const USAGE = `Usage: preview.ts <${Command.options.join("|")}> [--pr <n>] [--name <ref>] [--apps ${AppsMode.options.join("|")}] [--dry-run]`;

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
 *  check, Playwright's report to print after vitest's. What may stream through runs by
 *  deploy-helpers' `runAsync`. */
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

// ── GitHub over fetch ──────────────────────────────────────────────────────────────────────────

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** A GitHub 5xx is asked again twice, 5 s apart: every call here is a read or a whole-body write,
 *  so a repeat is harmless, and one 500 had failed a run whose checks had passed (#2911). */
async function github<T = unknown>(route: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method || "GET";
  let response: Response;
  for (let attempt = 1; ; attempt++) {
    response = await fetch(`https://api.github.com${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        "user-agent": "os-preview",
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status < 500 || attempt === 3) break;
    console.log(
      `GitHub ${method} ${route} answered ${response.status}; asking again (${attempt}/3)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${route} failed with ${response.status}`);
  }
  // GitHub's REST shapes are stable and documented; each caller declares the two or three fields it reads.
  return (await response.json()) as T;
}

const repository = () => requireEnv("GITHUB_REPOSITORY");

/** Read, splice, write, read back: the PR body has no conditional update, so a person editing the
 *  description in the same seconds could lose one write or the other. Reading it back and
 *  re-splicing onto whatever is there now converges on both edits within a few rounds. `what` names
 *  the write in the log: the whole preview section, or its status line alone. */
async function writePullRequestBody(
  prNumber: string,
  what: string,
  splice: (body: string) => string,
) {
  const route = `/repos/${repository()}/pulls/${prNumber}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = (await github<{ body: string | null }>(route)).body || "";
    const body = splice(before);
    if (body === before) return console.log(`PR #${prNumber}'s body already carries ${what}`);
    await github(route, { method: "PATCH", body: { body } });
    const after = (await github<{ body: string | null }>(route)).body || "";
    if (after === body) return console.log(`wrote ${what} into the body of PR #${prNumber}`);
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

/** Where the preview stands, as the PR body's status line (preview-config.ts `PreviewStatus`):
 *  this checkout's commit, this CI job (`DEPOT_JOB_URL`), now. Only with a PR and a token; a
 *  write that fails is logged, never the job's failure — the job's own outcome stands. */
async function writeStatus(
  prNumber: string | undefined,
  status: Pick<PreviewStatus, "state" | "failedSuites" | "error">,
) {
  if (!prNumber || !process.env.GITHUB_TOKEN) return;
  await (async () => {
    const full: PreviewStatus = {
      ...status,
      commit: checkedOutCommit(),
      runUrl: process.env.DEPOT_JOB_URL,
      at: new Date(),
    };
    await writePullRequestBody(prNumber, `the preview status (${status.state})`, (body) =>
      splicePreviewStatus(body, full),
    );
  })().catch((error: unknown) =>
    console.warn(`could not write the preview status (${status.state}): ${describe(error)}`),
  );
}

// ── leftover D1s (no preview creates one any more; deletePreview and the sweep delete them) ─────

type D1Row = { uuid: string; name: string; created_at?: string };

/** The list API's `name` filter matches by prefix (measured), so the exact match is made here. */
async function findDatabase(cf: Cf, name: string) {
  return (await listAll<D1Row>(cf, "/d1/database")).find((row) => row.name === name);
}

async function deleteDatabase(cf: Cf, name: string) {
  const row = await findDatabase(cf, name);
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
 *  preview off the app's parent, deploying the parent from the same config the first time it is
 *  missing, as cloudflare-os's `deployBaselineWorker` does. */
async function deployAppPreview(
  app: StartApp,
  previewName: string,
  input: { issuer: string; appOrigins: Record<string, string> },
  wrangler: string,
) {
  const root = path.resolve(import.meta.dirname, "../..", app.name);
  const config = writeStartAppPreviewConfig(app, input);
  const previewArgs = ["preview", "--name", previewName, "-c", config, "--json"];
  let result = await run(wrangler, previewArgs, { cwd: root });
  if (result.status !== 0 && isMissingWorkerError(`${result.stdout}\n${result.stderr}`)) {
    console.log(`apps/${app.name}: parent worker missing; deploying it from the same config`);
    await runAsync(wrangler, ["deploy", "-c", config], { cwd: root });
    result = await run(wrangler, previewArgs, { cwd: root });
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0)
    throw new Error(
      `apps/${app.name}: wrangler preview failed with exit code ${result.status}\n${lastLines(`${result.stdout}\n${result.stderr}`, 40)}`,
    );
  const url = parseWranglerJson(result.stdout).preview?.urls?.[0];
  if (url !== appPreviewUrl(app, previewName))
    throw new Error(
      `apps/${app.name}: expected ${appPreviewUrl(app, previewName)}, wrangler returned ${url}`,
    );
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
    const paths: string[] = [];
    for (let page = 1; ; page++) {
      // GET /pulls/{n}/files: one `filename` per changed file, 100 per page.
      const files = await github<{ filename: string }[]>(
        `/repos/${repository()}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      );
      paths.push(...files.map((file) => file.filename));
      if (files.length < 100) return paths;
    }
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

// ── the preview itself ─────────────────────────────────────────────────────────────────────────

/** `preview secret bulk` writes the WORKER's Previews settings, which every preview of it inherits:
 *  one upload covers every preview, and each run refreshes them. The two secrets are the deployment's
 *  (src/app-config.ts, scripts/deploy.ts ships the same two): the one `APP_CONFIG` object —
 *  `login.password`, `secrets.adminBearer` — and `APP_CONFIG_SECRETS__KEY` beside it. Values go
 *  through a 0600 tmp file, never argv or the config. */
async function uploadPreviewSecrets(wrangler: string, ctx: EnvContext<OsEnv>) {
  const secrets = collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]);
  const dir = mkdtempSync(path.join(tmpdir(), "os-preview-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    await runAsync(wrangler, ["preview", "secret", "bulk", file, "-c", PREVIEW_CONFIG_NAME], {
      cwd: ROOT,
    });
    console.log(
      `uploaded ${Object.keys(secrets).length} secrets to the Previews settings of ${PREVIEW_PARENT.workerName}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The OS's own preview, from an OS build already made — its Artifacts namespace, its config
 *  (naming the PR's Dash preview when this run deploys one), the Previews secrets, `wrangler
 *  preview`, and the smoke that the new deployment serves. The wrangler it prepared comes back for
 *  the apps on top; the caller cleans it up (here, when this fails). */
async function deployOsPreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  dashOrigin: string | undefined,
  recreated = false,
): Promise<{
  wrangler: ReturnType<typeof preparePreviewWrangler>;
  url: string;
  deploymentId: string;
  slug: string;
}> {
  await ensureArtifactsNamespace(ctx.cf, previewResourceName(previewName, "repos"));
  writePreviewWranglerConfig({ previewName, dashOrigin });
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    await uploadPreviewSecrets(wrangler.command, ctx);
    const result = await run(wrangler.command, [
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
      // its resources and create it again, once.
      if (!recreated && isDurableObjectClassNotExportedError(output)) {
        console.warn(
          `preview ${previewName} lacks a Durable Object class this build binds (Cloudflare 10061), and an existing Worker Preview cannot gain one: deleting the preview and its resources, then creating it again`,
        );
        await deletePreview(ctx.cf, previewName, wrangler.command);
        wrangler.cleanup();
        return deployOsPreview(ctx, previewName, dashOrigin, true);
      }
      const hint = isMissingWorkerError(output)
        ? ` — the parent worker ${PREVIEW_PARENT.workerName} is missing; deploy it first: pnpm --dir apps/os run deploy --env preview`
        : isDurableObjectClassNotExportedError(output)
          ? ` — Cloudflare 10061 on a new preview too: the parent worker ${PREVIEW_PARENT.workerName} does not export a Durable Object class this build binds. Deploy the parent from main (pnpm --dir apps/os run deploy --env preview); a PR that itself adds a class needs the parent deployed from its branch first`
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
    // apps/os's smoke is `/version` naming the new deployment (src/worker.ts); propagation was
    // observed at a few seconds.
    await smokeResponse(
      `${url}/version`,
      async (response) =>
        response.status === 200 && (await response.text()).startsWith(deploymentId),
      "version names the deployment",
    );
    return { wrangler, url, deploymentId, slug: data.preview?.slug || previewName };
  } catch (error) {
    wrangler.cleanup();
    throw error;
  }
}

/** The status line says `deploying` first and `deploy failed`, with the error's tail, when any
 *  step throws; a deploy that lands rewrites the whole section, `deployed`. */
async function deployPreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  await writeStatus(prNumber, { state: "deploying" });
  try {
    await deployPreviewSteps(ctx, previewName, prNumber, apps);
  } catch (error) {
    await writeStatus(prNumber, { state: "deploy failed", error: describe(error) });
    throw error;
  }
}

async function deployPreviewSteps(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  assertFreshInstall(REPO_ROOT);
  // The apps' vite builds run beside apps/os's build, their rejection handlers attached at once:
  // apps/os's build and deployment can take minutes, and an app build may fail before its result is
  // consumed. Each step is a span in the CI trace (docs/ci-traces.md), so the deploy step shows
  // where its time went.
  const appBuilds = Promise.allSettled(
    apps.map((app) => traceOperation(`Build ${app.name}`, () => buildStartApp(app, "preview"))),
  );
  await traceOperation("Build OS", () => buildOs("preview"));
  const appBuildResults = await appBuilds;
  const failedBuilds = appBuildResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ app: apps[index]!.name, error: describe(result.reason) }]
      : [],
  );
  // the apps on the first line (the PR body's summary), each one's error and output tail after it
  if (failedBuilds.length)
    throw new Error(
      `app preview build failed: ${failedBuilds.map(({ app }) => app).join(", ")}\n${failedBuilds.map(({ app, error }) => `${app}: ${error}`).join("\n\n")}`,
    );
  const appOrigins = appPreviewOrigins(apps, previewName);
  const { wrangler, url, deploymentId, slug } = await traceOperation("Deploy OS preview", () =>
    deployOsPreview(ctx, previewName, appOrigins.dash),
  );
  try {
    const appPreviews = await Promise.all(
      apps.map((app) =>
        traceOperation(`Deploy ${app.name}`, () =>
          deployAppPreview(app, previewName, { issuer: url, appOrigins }, wrangler.command),
        ),
      ),
    );
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
      apps: appPreviews,
      // the workflow's scripts/ci/preview-tested-commit.ts: the PR merged into main, or the head alone
      testedCommit: process.env.PREVIEW_TESTED_COMMIT,
      signIn: prNumber
        ? await traceOperation("Seed sign-in", () =>
            previewSignIn(ctx, { url, prNumber, apps: appPreviews }),
          )
        : undefined,
    };
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(path.join(OUTPUT_DIR, "preview.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\npreview ${previewName}: ${url}`);
    if (prNumber && process.env.GITHUB_TOKEN) {
      const section = renderPullRequestSection(summary);
      await writePullRequestBody(prNumber, "the preview section", (body) =>
        splicePullRequestBody(body, section),
      );
    }
  } finally {
    wrangler.cleanup();
  }
}

/** THE ONE-CLICK SIGN-IN a PR's body links (src/test-link.ts): seed the PR's test person and
 *  project, mint the links — with the Dash, one per config template into its New project sheet
 *  (preview-config.ts `templateQuickLaunches`) — and smoke the heading's. The person is `pr<N>@preview.iterate.test`,
 *  the project `pr<N>` — created as them through the operator's bearer (`as`), the same idempotent
 *  call as e2e/support/project-host.ts `registerProject`, so the Dash link lands inside it. Each
 *  link is signed with the preview's own key for this preview's origin, expires in 14 days (every
 *  push mints a fresh one) and pre-approves this run's app previews (consent.ts: no Allow page).
 *  The heading's lands in the Dash's `/projects/pr<N>` when the Dash was previewed, else on the
 *  issuer's own `/login` ("Signed in as"). Neither the seed nor the smoke ever fails the deploy:
 *  they log, and the section says when the seed failed. */
async function previewSignIn(
  ctx: EnvContext<OsEnv>,
  preview: { url: string; prNumber: string; apps: { name: string; url: string }[] },
) {
  // The preview's two inherited secrets, parsed the way the worker parses them (uploadPreviewSecrets).
  const config = parseAppConfig(collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]));
  const { email, project } = testLinkIdentityOf(preview.prNumber);
  let seeded = false;
  try {
    const socketUrl = new URL("/api", preview.url);
    socketUrl.protocol = "wss:";
    const socket = new WebSocket(socketUrl);
    // Undici implements the WebSocket transport; Workers' ambient type has extra unrelated members.
    // The one call it makes, typed here: `iterate/next/api`'s types need the worker's lib, which
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
          changedPaths: await changedPaths(preview.prNumber).catch((error: unknown) => {
            console.warn(
              `sign-in: ${describe(error)}; every template link names the preview's own copy`,
            );
            return [];
          }),
          // the PR head (the workflow's), which GitHub keeps; a laptop's checkout is its head
          headSha: process.env.PREVIEW_HEAD_SHA || checkedOutCommit(),
        }).map(async ({ name, fromHead, next }) => ({ name, fromHead, link: await link(next) })),
      )
    : [];
  const smoke = await fetch(heading, { redirect: "manual" }).catch((error: unknown) => error);
  if (smoke instanceof Response && smoke.status === 302 && smoke.headers.has("set-cookie"))
    console.log(`sign-in: the heading link signs in (302 to ${smoke.headers.get("location")})`);
  else
    console.warn(
      `sign-in: the heading link did not sign in: ${smoke instanceof Response ? `${smoke.status} ${await smoke.text()}` : describe(smoke)}`,
    );
  return { heading, apps, templates, email, project, seeded };
}

/** The preview, then everything it owned, each found by its name: its Artifacts namespace (this
 *  script created it), any `db` D1 a preview from before the control plane moved to a Durable Object
 *  left behind, its KV namespaces and its R2 bucket (wrangler provisioned them; see WRANGLER_PACKAGE
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
 *  the workspace is what the CI finalizer (`upload-test-telemetry.ts --flake-suites preview`, which
 *  expects exactly these two workspaces) and scripts/ci/flake-suite-summary.ts match a suite by, and
 *  each suite records its flake lines into its own `flake-records-<suite>` directory (relative to
 *  GITHUB_WORKSPACE). Only when the workflow asks for telemetry (TEST_TELEMETRY_ARTIFACT_DIR): a run
 *  from a laptop records nothing. */
const PREVIEW_SUITE_TELEMETRY: Record<"specs" | "preview-e2e", Record<string, string>> = process.env
  .TEST_TELEMETRY_ARTIFACT_DIR
  ? {
      specs: {
        TEST_TELEMETRY_WORKSPACE: "iterate-root",
        FLAKE_RECORD_DIR: "test-results/flake-records/specs",
      },
      "preview-e2e": {
        TEST_TELEMETRY_WORKSPACE: "os",
        TEST_TELEMETRY_KIND: "e2e",
        TEST_TELEMETRY_LANE: "vitest",
        FLAKE_RECORD_DIR: "test-results/flake-records/preview-e2e",
      },
    }
  : { specs: {}, "preview-e2e": {} };

/** THE PROOF: the vitest e2e suite and the root Playwright specs (specs/AGENTS.md), both in
 *  deployed-target mode against the preview, side by side — the same two suites `pnpm e2e` and
 *  `pnpm spec` run. Each runner derives the deployed target itself
 *  (e2e/support/deployed-target.ts, from the `APP_CONFIG` in this process's environment and the
 *  parent's envs.ts entry): the vitest suite in its global-setup, the specs in specs/setup.ts. Every
 *  spec project runs, the notes and voice projects against this preview's Notes and Voice apps, the
 *  Notes session specs signing out in its Dash (NOTES_BASE_URL, VOICE_BASE_URL, DASH_BASE_URL;
 *  their specs fail in CI without them). vitest streams; Playwright's report prints after it. The
 *  status line in the PR body then says `e2e passed`, or `e2e failed` and which suites. */
async function runE2e(previewName: string, prNumber: string | undefined) {
  let failedSuites: string[];
  try {
    failedSuites = await runE2eSuites(previewName);
  } catch (error) {
    await writeStatus(prNumber, { state: "e2e failed", error: describe(error) });
    throw error;
  }
  await writeStatus(
    prNumber,
    failedSuites.length ? { state: "e2e failed", failedSuites } : { state: "e2e passed" },
  );
  if (failedSuites.length > 0)
    throw new Error(`${failedSuites.join(" and ")} failed against ${previewUrl(previewName)}`);
}

/** The two suites side by side; the names of those that failed. */
async function runE2eSuites(previewName: string) {
  const url = previewUrl(previewName);
  const env = { WORKER_BASE_URL: url, DEMO_BASE_URL: url };
  const appUrl = (name: string) =>
    appPreviewUrl(APPS.find((app) => app.name === name)!, previewName);
  const spec = (async () => {
    if (process.env.CI)
      await runAsync("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: REPO_ROOT,
      });
    return run("pnpm", ["spec"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...env,
        NOTES_BASE_URL: appUrl("notes"),
        VOICE_BASE_URL: appUrl("voice"),
        DASH_BASE_URL: appUrl("dash"),
        ...PREVIEW_SUITE_TELEMETRY.specs,
      },
    });
  })();
  // `e2e:run`, not `e2e`: the deployed target needs no local build, and the preview's built dist/
  // stays intact while Playwright runs beside Vitest.
  const e2e = runAsync("pnpm", ["e2e:run"], {
    cwd: ROOT,
    env: { ...env, ...PREVIEW_SUITE_TELEMETRY["preview-e2e"] },
  }).then(
    () => true,
    (error: unknown) => {
      console.error(describe(error));
      return false;
    },
  );
  const [specResult, e2ePassed] = await Promise.all([spec, e2e]);
  process.stdout.write(
    `\n── playwright (pnpm spec) ──\n${specResult.stdout}${specResult.stderr}\n`,
  );
  return [!e2ePassed && "vitest e2e", specResult.status !== 0 && "pnpm spec"].filter(
    (suite) => suite !== false,
  );
}

// ── sweep (cloudflare-os: GitHub has no `environment.auto_stop_in`) ────────────────────────────

/** A 404 is an answer: the number came out of a live preview's name, so a PR that does not exist
 *  means the preview outlived it. A transient failure must never be what deletes a preview an open
 *  PR still uses, so it falls back to age alone. */
async function pullRequestState(number: number): Promise<PullRequestState> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repository()}/pulls/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "os-preview-sweep",
        ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
      },
    });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`GitHub GET pulls/${number} failed with ${response.status}`);
    // GET /pulls/{n}: `state` is "open" | "closed" per the docs; anything else is refused below.
    const { state } = (await response.json()) as { state: string };
    if (state === "open" || state === "closed") return state;
    throw new Error(`GitHub reported the state ${JSON.stringify(state)}`);
  } catch (error) {
    console.warn(`${describe(error)}; PR #${number}'s preview is judged on age alone.`);
    return "unknown";
  }
}

/** Every open pull request's head branch — what keeps a preview named after a branch (preview-sweep.ts
 *  rule 3) — or undefined when GitHub cannot say, and rule 3 then deletes nothing. */
async function openPullRequestBranches() {
  try {
    const branches: string[] = [];
    for (let page = 1; ; page++) {
      // GET /pulls?state=open: one `head.ref` per open pull request, 100 per page.
      const pulls = await github<{ head: { ref: string } }[]>(
        `/repos/${repository()}/pulls?state=open&per_page=100&page=${page}`,
      );
      branches.push(...pulls.map((pull) => pull.head.ref));
      if (pulls.length < 100) return branches;
    }
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

/** Main's superseded throwaway previews (preview-sweep.ts `supersededMainPreviews`), each deleted
 *  with everything it owns and the apps on top: the delete a cancelled run never ran. */
async function deleteSupersededMainPreviews(cf: Cf, current: string, dryRun: boolean) {
  const listed = await listAll<ListedPreview>(
    cf,
    `/workers/workers/${PREVIEW_PARENT.workerName}/previews`,
  ).catch((error) => {
    if (!isMissingWorkerError(describe(error))) throw error;
    return [] as ListedPreview[]; // a parent not yet deployed holds no previews
  });
  const superseded = supersededMainPreviews(
    listed.map((preview) => preview.name),
    current,
  );
  console.log(
    `superseded main previews on ${PREVIEW_PARENT.workerName}: ${superseded.join(", ") || "none"}`,
  );
  if (dryRun) return;
  for (const name of superseded) await deleteAll(cf, name);
}

const RESOURCE_KIND_LABELS: Record<SweptResource["kind"], string> = {
  kv: "KV namespace",
  r2: "R2 bucket",
  d1: "D1",
  artifacts: "Artifacts namespace",
};

/** The stale previews (deletePreview, and the apps on top of the same name) and the resources that
 *  outlived their preview, by the rules in scripts/preview-sweep.ts. */
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
    const parent = app.envs.preview!.workerName;
    const listed = await listAll<ListedPreview>(cf, `/workers/workers/${parent}/previews`).catch(
      (error) => {
        if (!isMissingWorkerError(describe(error))) throw error;
        return [] as ListedPreview[]; // a parent never deployed holds no previews
      },
    );
    for (const preview of listed) appPreviews.push({ app, name: preview.name });
  }
  const scripts = await cf<{ id: string; created_on?: string }[]>("/workers/scripts");
  const workerNames = scripts.map((script) => script.id);
  const resourceSuffixes = previewResourceSuffixes();
  // The pull requests the rules read: a preview's (rule 2), a leftover D1's or Artifacts namespace's
  // (rule 6).
  const pullRequestNumbers = new Set(
    [
      ...previews.map((preview) => preview.name),
      ...resources
        .filter((resource) => resource.kind === "d1" || resource.kind === "artifacts")
        .map(
          (resource) =>
            previewNameOfSweptResource(resource, { workerNames, resourceSuffixes }) || "",
        ),
    ]
      .map((name) => previewPullRequestNumber(name))
      .filter((number) => number !== undefined),
  );
  const pullRequestStates = new Map<number, PullRequestState>();
  for (const number of pullRequestNumbers)
    pullRequestStates.set(number, await pullRequestState(number));
  const plan = planPreviewSweep({
    now: Date.now(),
    workerNames,
    parentCreatedAt: scripts.find((script) => script.id === PREVIEW_PARENT.workerName)?.created_on,
    resourceSuffixes,
    previews: previews.map((preview) => ({
      name: preview.name,
      lastDeployedAt: preview.deployed_on || preview.created_on,
    })),
    resources,
    pullRequestStates,
    openPullRequestBranches: await openPullRequestBranches(),
  });
  const stale = plan.previews.filter((preview) => preview.verdict === "stale");
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
  const orphanCounts = Object.entries(RESOURCE_KIND_LABELS).map(
    ([kind, label]) => `${plan.orphans.filter((orphan) => orphan.kind === kind).length} ${label}`,
  );
  console.log(
    `plan: ${stale.length} stale preview(s); orphans: ${orphanCounts.join(", ")}; ${staleAppPreviews.length} app preview(s)`,
  );
  if (dryRun || (stale.length === 0 && plan.orphans.length === 0 && staleAppPreviews.length === 0))
    return;
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    const failures: string[] = [];
    // Cloudflare's, not the sweep's: paged, and tried again the next night (StuckArtifactsNamespace).
    const stuckNamespaces: StuckArtifactsNamespace[] = [];
    const noteStuck = (stuck: StuckArtifactsNamespace | undefined) => {
      if (stuck) stuckNamespaces.push(stuck);
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
      for (const orphan of plan.orphans.filter((row) => row.previewName === previewName)) {
        const deleteOrphan = {
          kv: () => deleteKvNamespace(cf, { id: orphan.id, title: orphan.name }),
          r2: () => deleteR2Bucket(cf, orphan.name),
          d1: async () => {
            await cf(`/d1/database/${orphan.id}`, { method: "DELETE" });
            console.log(`deleted D1 ${orphan.name}`);
          },
          artifacts: async () => noteStuck(await deleteArtifactsNamespace(cf, orphan.name)),
        }[orphan.kind];
        await deleteOrphan().catch((error) => failures.push(`${orphan.name}: ${describe(error)}`));
      }
    }
    for (const { app, name } of staleAppPreviews) {
      await deleteWorkerPreview(app.envs.preview!, name, wrangler.command).catch((error) =>
        failures.push(`apps/${app.name} ${name}: ${describe(error)}`),
      );
    }
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
  } finally {
    wrangler.cleanup();
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: Command;
  pr?: string;
  name?: string;
  apps?: AppsMode;
  dryRun: boolean;
} {
  const command = Command.safeParse(argv[0]);
  if (!command.success) throw new Error(USAGE);
  let pr: string | undefined;
  let name: string | undefined;
  let apps: AppsMode | undefined;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--pr") pr = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--apps") {
      const mode = AppsMode.safeParse(argv[++i]);
      if (!mode.success) throw new Error(USAGE);
      apps = mode.data;
    } else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { command: command.data, pr, name, apps, dryRun };
}

/** The branch a PR-numbered run names its preview after: the flag, PREVIEW_NAME (the workflow's
 *  `github.head_ref`), or — a dispatch that only knows the number — the PR's head ref from GitHub. */
async function resolveBranch(pr: string | undefined, name: string | undefined) {
  if (name) return name;
  if (process.env.PREVIEW_NAME) return process.env.PREVIEW_NAME;
  if (pr && process.env.GITHUB_TOKEN) {
    const pull = await github<{ head: { ref: string } }>(`/repos/${repository()}/pulls/${pr}`);
    return pull.head.ref;
  }
  throw new Error(
    "a preview needs a branch: --name <ref>, PREVIEW_NAME, or --pr with GITHUB_TOKEN",
  );
}

/** The flags, then the workflow's spellings — PREVIEW_PR_NUMBER, PREVIEW_APPS (all | auto | none),
 *  PREVIEW_NAME (resolveBranch) — then the defaults. */
async function main(argv: string[]) {
  const parsed = parseArgs(argv);
  const pr = parsed.pr || process.env.PREVIEW_PR_NUMBER;
  const appsMode = parsed.apps || AppsMode.parse(process.env.PREVIEW_APPS || "all");
  if (parsed.command === "sweep")
    return sweep((await parentContext()).cf, {
      dryRun: parsed.dryRun,
      jobUrl: process.env.DEPOT_JOB_URL,
    });
  const branch = await resolveBranch(pr, parsed.name);
  const previewName = resolvePreviewName({ name: branch, prNumber: pr });
  console.log(`preview ${previewName} → ${previewUrl(previewName)}`);
  if (parsed.command === "delete-superseded")
    return deleteSupersededMainPreviews((await parentContext()).cf, previewName, parsed.dryRun);
  if (parsed.command === "config" || parsed.dryRun) {
    await buildOs("preview");
    console.log(`wrote ${writePreviewWranglerConfig({ previewName })}`);
    return;
  }
  if (parsed.command === "e2e") return runE2e(previewName, pr);
  const ctx = await parentContext();
  if (parsed.command === "delete") return deleteAll(ctx.cf, previewName);
  if (parsed.command === "reset") await deleteAll(ctx.cf, previewName);
  return deployPreview(ctx, previewName, pr, await appsToPreview(appsMode, pr));
}

if (process.argv[1]?.endsWith("preview.ts")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describe(error));
    process.exit(1);
  });
}
