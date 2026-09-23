// scripts/preview.ts — one Worker Preview per pull request of the one worker, the cloudflare-os recipe
// (their scripts/preview/preview.ts: eighteen workers in three tiers collapsed to one). The effects
// half; the pure half — naming, the PR body's section, the preview's wrangler config — is
// scripts/preview-config.ts (preview.test.ts). Commands: config (build and write preview config),
// deploy (build, the Artifacts namespace, the secrets, `wrangler preview`, the PR body),
// e2e (vitest and Playwright against the live preview), residency (after e2e: fail on any Durable
// Object still resident with no client connected; scripts/preview-residency.ts), release (after
// residency: redeploy — never a reset — ending the sessions the run left open), reset (delete, then
// deploy), delete (the preview, its Artifacts namespace, KV namespaces and R2 bucket, plus any
// leftover D1, the apps on top), sweep (the stale previews and the resources that outlived theirs —
// the rules are scripts/preview-sweep.ts). `--dry-run` prints the plan.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { osEnvs, type OsEnv } from "../../../envs.ts";
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
import { buildOsNext } from "./build.ts";
import {
  APPS,
  changedApps,
  PREVIEW_CONFIG_NAME,
  PREVIEW_PARENT,
  previewPullRequestNumber,
  previewResourceName,
  previewResourceSuffixes,
  previewUrl,
  renderPullRequestSection,
  RESIDENCY_SECTION_MARKERS,
  resolvePreviewName,
  splicePullRequestBody,
  writePreviewWranglerConfig,
} from "./preview-config.ts";
import {
  DURABLE_OBJECT_RESIDENCY_QUERY,
  DurableObjectNamespace,
  DurableObjectResidencyAnswer,
  durableObjectAnalyticsCoverWindow,
  durableObjectResidencyVariables,
  durableObjectResidencyVerdict,
  durableObjectResidencyWindow,
  previewDurableObjectNamespaces,
  renderDurableObjectResidency,
} from "./preview-residency.ts";
import {
  planPreviewSweep,
  previewNameOfSweptResource,
  type PullRequestState,
  type SweptResource,
} from "./preview-sweep.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
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
  "residency",
  "release",
  "reset",
  "delete",
  "sweep",
]);
type Command = z.infer<typeof Command>;
/** The apps on top: every one by default, none, or (auto) the ones whose paths this PR changes. */
const AppsMode = z.enum(["all", "auto", "none"]);
type AppsMode = z.infer<typeof AppsMode>;
export const DEFAULT_APPS_MODE = "all" satisfies AppsMode;
const USAGE = `Usage: preview.ts <${Command.options.join("|")}> [--pr <n>] [--name <ref>] [--apps ${AppsMode.options.join("|")}] [--dry-run]`;

/** The Cloudflare API on the parent's account (scripts/lib/env-context.ts: the envelope checked,
 *  429s retried, a truncated listing refused). */
type Cf = EnvContext<OsEnv>["cf"];

/** The parent's Doppler config (project-worker/preview), downloaded — the Cloudflare credentials for
 *  its account and the two secrets every preview inherits — the way ensure-resources and erase-data
 *  resolve theirs. Refuses a Doppler account that is not the parent's. */
const parentContext = () =>
  resolveEnvContext({ envs: osEnvs, dopplerProject: "project-worker", env: "preview" });

// ── process helpers (cloudflare-os) ────────────────────────────────────────────────────────────

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a command and capture its output — wrangler's `--json` payload, its prose for a not-found
 *  check, Playwright's report to print after vitest's. What may stream through runs by
 *  deploy-helpers' `runAsync`. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  console.log(
    `running${options.cwd ? ` in ${path.relative(ROOT, options.cwd) || "."}` : ""}: ${command} ${args.join(" ")}`,
  );
  return new Promise<CommandResult>((resolve, reject) => {
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
    child.once("error", (error) => reject(new Error(`failed to run ${command}: ${error.message}`)));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The wrangler a run uses: PREVIEW_WRANGLER, or the pinned draft build installed into a tmpdir the
 *  way cloudflare-os does it (pnpm, exotic subdeps allowed for the pkg.pr.new workspace packages). */
function preparePreviewWrangler(): { command: string; ready: Promise<void>; cleanup: () => void } {
  const override = process.env.PREVIEW_WRANGLER;
  if (override) return { command: override, ready: Promise.resolve(), cleanup: () => {} };
  const installDir = mkdtempSync(path.join(tmpdir(), "os-next-preview-wrangler-"));
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
async function listAll<T>(cf: Cf, route: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await cf<T[]>(`${route}?per_page=100&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

// ── GitHub over fetch ──────────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github<T = unknown>(route: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method: init.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
      "user-agent": "os-next-preview",
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${init.method || "GET"} ${route} failed with ${response.status}`);
  }
  // GitHub's REST shapes are stable and documented; each caller declares the two or three fields it reads.
  return (await response.json()) as T;
}

const repository = () => requireEnv("GITHUB_REPOSITORY");

/** Read, splice, write, read back: the PR body has no conditional update, so a person editing the
 *  description in the same seconds could lose one write or the other. Reading it back and
 *  re-splicing onto whatever is there now converges on both edits within a few rounds. */
async function writePullRequestSection(
  prNumber: string,
  section: string,
  markers?: typeof RESIDENCY_SECTION_MARKERS,
): Promise<void> {
  const route = `/repos/${repository()}/pulls/${prNumber}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = (await github<{ body: string | null }>(route)).body || "";
    const body = splicePullRequestBody(before, section, markers);
    if (body === before)
      return console.log(`PR #${prNumber}'s body already carries this preview section`);
    await github(route, { method: "PATCH", body: { body } });
    const after = (await github<{ body: string | null }>(route)).body || "";
    if (after === body)
      return console.log(`wrote the preview section into the body of PR #${prNumber}`);
    console.warn(
      `PR #${prNumber}'s body changed under the write (attempt ${attempt}); re-splicing`,
    );
  }
  throw new Error(
    `could not write the preview section into PR #${prNumber}'s body: it kept changing`,
  );
}

// ── the D1 (not auto-provisioned: created here, deleted here) ──────────────────────────────────

type D1Row = { uuid: string; name: string; created_at?: string };

/** The list API's `name` filter matches by prefix (measured), so the exact match is made here. */
async function findDatabase(cf: Cf, name: string): Promise<D1Row | undefined> {
  return (await listAll<D1Row>(cf, "/d1/database")).find((row) => row.name === name);
}

async function deleteDatabase(cf: Cf, name: string): Promise<void> {
  const row = await findDatabase(cf, name);
  if (!row) return console.warn(`D1 ${name} did not exist; continuing.`);
  await cf(`/d1/database/${row.uuid}`, { method: "DELETE" });
  console.log(`deleted D1 ${name}`);
}

// ── the Artifacts namespace (not auto-provisioned: created here, deleted here) ─────────────────

type ArtifactsNamespaceRow = { namespace: string; repo_count?: number; created_at?: string };

/** Cloudflare's error envelope, the codes only — what a refusal is told apart by. */
const CloudflareErrors = z.array(z.object({ code: z.number() }));

/** A Cloudflare refusal with this status and error code. Each one used here was measured:
 *  Artifacts 404/10200 (no such namespace, or repo), 409/10202 (namespace still holds repos) and
 *  409/10305 (namespace deletion already in progress); KV
 *  404/10013 (no such namespace); R2 404/10006 (no such bucket); Worker Previews 404/10025 (no such
 *  preview). */
const isCloudflareError = (error: unknown, status: number, code: number) =>
  error instanceof CloudflareApiError &&
  error.status === status &&
  (CloudflareErrors.safeParse(error.details).data ?? []).some((entry) => entry.code === code);

/** A preview's namespace, by name. The worker's repo create does NOT provision one: on a missing
 *  namespace it fails with "Namespace is not active" (measured 2026-09-22), and the binding names
 *  the namespace only. */
async function ensureArtifactsNamespace(cf: Cf, artifactsNamespaceName: string): Promise<void> {
  const existing = await cf<ArtifactsNamespaceRow>(
    `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`,
  ).catch((error) => {
    if (isCloudflareError(error, 404, 10200)) return undefined;
    throw error;
  });
  if (!existing)
    await cf("/artifacts/namespaces", {
      method: "POST",
      body: JSON.stringify({ namespace: artifactsNamespaceName }),
    });
  console.log(`${existing ? "found" : "created"} Artifacts namespace ${artifactsNamespaceName}`);
}

/** Delete a preview's Artifacts namespace: every repo first (the API refuses a namespace that is
 *  not empty), then the namespace. A repo delete is ACCEPTED (202) and lands after the answer, so
 *  the list is read again until it is empty and the namespace delete stops answering "not empty";
 *  a ceiling keeps that bounded. A namespace that does not exist — a preview deleted before its
 *  deploy created one, a re-run of the cleanup job, the sweep racing the close job — is the
 *  expected case. */
async function deleteArtifactsNamespace(cf: Cf, artifactsNamespaceName: string): Promise<void> {
  const route = `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`;
  // The namespace itself is what answers "does not exist" (404, code 10200); its repos list answers
  // an empty page for a missing namespace (measured 2026-09-22), so the check is on the namespace.
  const existing = await cf<ArtifactsNamespaceRow>(route).catch((error) => {
    if (isCloudflareError(error, 404, 10200)) return undefined;
    throw error;
  });
  if (!existing)
    return console.warn(`Artifacts namespace ${artifactsNamespaceName} did not exist; continuing.`);
  let deletedRepos = 0;
  for (let round = 1; ; round++) {
    if (round > 200)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} is still not empty after ${deletedRepos} repo deletes`,
      );
    // The first page, read again each round until it is empty — that is this loop's pagination, so
    // `page=1` is named (env-context refuses a truncated listing that names no page).
    const repos = await cf<{ name: string }[]>(`${route}/repos?limit=200&page=1`);
    // ten at a time: one delete answers in ~1 s (measured), and a preview's e2e run leaves hundreds
    for (let i = 0; i < repos.length; i += 10) {
      await Promise.all(
        repos.slice(i, i + 10).map((repo) =>
          // one already gone (a delete accepted on an earlier round) is fine
          cf(`${route}/repos/${encodeURIComponent(repo.name)}`, { method: "DELETE" }).catch(
            (error) => {
              if (!isCloudflareError(error, 404, 10200)) throw error;
            },
          ),
        ),
      );
      deletedRepos += Math.min(10, repos.length - i);
    }
    if (repos.length > 0) continue;
    // gone under this run (the sweep and the close job can race) is deleted, and so is one whose
    // deletion Cloudflare already has in progress (409/10305; one sat there with `repo_count: 1` and
    // an empty repos list for minutes, 2026-09-23)
    const deleted = await cf(route, { method: "DELETE" }).then(
      () => true,
      (error) => {
        if (isCloudflareError(error, 404, 10200) || isCloudflareError(error, 409, 10305))
          return true;
        if (!isCloudflareError(error, 409, 10202)) throw error;
        return false;
      },
    );
    if (deleted) break;
    await new Promise((resolve) => setTimeout(resolve, 2000)); // accepted deletes still landing
  }
  console.log(`deleted Artifacts namespace ${artifactsNamespaceName} (${deletedRepos} repos)`);
}

// ── the KV namespaces and the R2 bucket (provisioned by `wrangler preview`, deleted here) ──────

type KvNamespaceRow = { id: string; title: string };

/** One already gone — the sweep racing the close job, a re-run — is deleted. */
async function deleteKvNamespace(cf: Cf, row: KvNamespaceRow): Promise<void> {
  await cf(`/storage/kv/namespaces/${row.id}`, { method: "DELETE" }).catch((error) => {
    if (!isCloudflareError(error, 404, 10013)) throw error;
  });
  console.log(`deleted KV namespace ${row.title}`);
}

/** Delete an R2 bucket: its objects first (the API refuses a bucket that still holds any), then the
 *  bucket. The first thousand-key page is read again until it is empty, twenty deletes in flight —
 *  a preview's e2e run leaves tens, the soak preview's bucket held 1,908 (measured 2026-09-23) — and
 *  a ceiling keeps that bounded. A bucket that does not exist is the expected case. */
async function deleteR2Bucket(cf: Cf, bucketName: string): Promise<void> {
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

/** The preview's URL, known before anything deploys (the same rule as os-next's). */
const appPreviewUrl = (app: StartApp, previewName: string) =>
  `https://${previewName}-${new URL(app.envs.preview!.baseUrl).hostname}`;

/** A config that names a parent worker and nothing else: enough for `wrangler preview delete`
 *  and the sweep, on a checkout that never built anything. */
function writeParentConfig(parent: { workerName: string; cloudflareAccountId: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "os-next-preview-parent-"));
  const file = path.join(dir, "wrangler.json");
  writeFileSync(
    file,
    JSON.stringify({ name: parent.workerName, account_id: parent.cloudflareAccountId }),
  );
  return file;
}

/** Build the app for the `preview` env, write its preview config with this PR's os-next preview
 *  as the issuer, and branch a preview off the app's parent — deploying the parent from the same
 *  config the first time it is missing, as cloudflare-os's `deployBaselineWorker` does. */
async function deployAppPreview(
  app: StartApp,
  previewName: string,
  issuer: string,
  wrangler: string,
): Promise<{ name: string; url: string }> {
  const root = path.resolve(import.meta.dirname, "../..", app.name);
  const config = writeStartAppPreviewConfig(app, { issuer });
  const previewArgs = ["preview", "--name", previewName, "-c", config, "--json"];
  let result = await run(wrangler, previewArgs, { cwd: root });
  if (result.status !== 0 && isMissingWorkerError(`${result.stdout}\n${result.stderr}`)) {
    console.log(`apps/${app.name}: parent worker missing; deploying it from the same config`);
    await runAsync(wrangler, ["deploy", "-c", config], { cwd: root });
    result = await run(wrangler, previewArgs, { cwd: root });
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0)
    throw new Error(`apps/${app.name}: wrangler preview failed with exit code ${result.status}`);
  const url = parseWranglerJson(result.stdout).preview?.urls?.[0];
  if (url !== appPreviewUrl(app, previewName))
    throw new Error(
      `apps/${app.name}: expected ${appPreviewUrl(app, previewName)}, wrangler returned ${url}`,
    );
  await smoke(`${url}/healthz`, (status) => status === 200, `apps/${app.name} health`);
  return { name: app.name, url };
}

/** The apps this run previews: --apps all, none, or (auto) the ones whose paths this PR changes. */
async function appsToPreview(mode: AppsMode, prNumber: string | undefined): Promise<StartApp[]> {
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
async function changedPaths(prNumber: string | undefined): Promise<string[]> {
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

/** `wrangler preview delete` of one preview of `parent` — os-next's or an app's. One that never
 *  existed — a PR closed before its first deploy, a re-run of the cleanup job, the sweep racing the
 *  close job, a parent never deployed — is the expected case, not a failure. */
async function deleteWorkerPreview(
  parent: { workerName: string; cloudflareAccountId: string },
  previewName: string,
  wrangler: string,
): Promise<void> {
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
async function uploadPreviewSecrets(wrangler: string, ctx: EnvContext<OsEnv>): Promise<void> {
  const secrets = collectSecrets(ctx, ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"]);
  const dir = mkdtempSync(path.join(tmpdir(), "os-next-preview-secrets-"));
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

/** A laptop deploy bundles whatever node_modules holds, so a lockfile newer than the install would
 *  ship stale dependencies: pnpm-lock.yaml newer than node_modules → stop. CI installs first. */
function assertFreshInstall() {
  const root = path.resolve(ROOT, "../..");
  const lockfile = statSync(path.join(root, "pnpm-lock.yaml")).mtimeMs;
  const installed = statSync(path.join(root, "node_modules", ".modules.yaml"), {
    throwIfNoEntry: false,
  })?.mtimeMs;
  if (installed === undefined || lockfile > installed)
    throw new Error("pnpm-lock.yaml is newer than node_modules: run `pnpm install` first");
}

/** The OS's own preview, from an OS build already made — its Artifacts namespace, its config
 *  (naming the PR's Dash preview when `apps` holds dash), the Previews secrets, `wrangler preview`,
 *  and the smoke that the new deployment serves. What `deploy` and `release` share. The wrangler it
 *  prepared comes back for the apps on top; the caller cleans it up (here, when this fails). */
async function deployOsPreview(ctx: EnvContext<OsEnv>, previewName: string, apps: StartApp[]) {
  await ensureArtifactsNamespace(ctx.cf, previewResourceName(previewName, "repos"));
  const dash = apps.find((app) => app.name === "dash");
  writePreviewWranglerConfig({
    previewName,
    dashOrigin: dash && `https://${previewName}-${new URL(dash.envs.preview!.baseUrl).hostname}`,
  });
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
      const hint = isMissingWorkerError(`${result.stdout}\n${result.stderr}`)
        ? ` — the parent worker ${PREVIEW_PARENT.workerName} is missing; deploy it first: pnpm deploy --env preview`
        : "";
      throw new Error(`wrangler preview failed with exit code ${result.status}${hint}`);
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
    // os-next's smoke is `/version` naming the new deployment (src/worker.ts); propagation was
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

async function deployPreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  assertFreshInstall();
  // The apps' vite builds run beside os-next's build, the D1 and the wrangler install.
  // Attach rejection handlers immediately: OS Next's build and deployment can take minutes, and
  // an app build may fail before we reach the point where its result is consumed.
  const appBuilds = Promise.allSettled(apps.map((app) => buildStartApp(app, "preview")));
  await buildOsNext("preview");
  const appBuildResults = await appBuilds;
  const failedBuilds = appBuildResults.flatMap((result, index) =>
    result.status === "rejected" ? [`${apps[index]!.name}: ${describe(result.reason)}`] : [],
  );
  if (failedBuilds.length) throw new Error(`app preview build failed: ${failedBuilds.join("; ")}`);
  const { wrangler, url, deploymentId, slug } = await deployOsPreview(ctx, previewName, apps);
  try {
    const appPreviews = await Promise.all(
      apps.map((app) => deployAppPreview(app, previewName, url, wrangler.command)),
    );
    const summary = {
      previewName,
      url,
      deploymentId,
      slug,
      dashboardUrl: `https://dash.cloudflare.com/${PREVIEW_PARENT.cloudflareAccountId}/workers/services/view/${PREVIEW_PARENT.workerName}/production/previews/${slug}`,
      apps: appPreviews,
      // the workflow's scripts/ci/preview-tested-commit.ts: the PR merged into main, or the head alone
      testedCommit: process.env.PREVIEW_TESTED_COMMIT,
    };
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(path.join(OUTPUT_DIR, "preview.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\npreview ${previewName}: ${url}`);
    if (prNumber && process.env.GITHUB_TOKEN)
      await writePullRequestSection(prNumber, renderPullRequestSection(summary));
  } finally {
    wrangler.cleanup();
  }
}

/** The preview, then everything it owned, each found by its name: its D1 and its Artifacts
 *  namespace (this script created them), its KV namespaces and its R2 bucket (wrangler provisioned
 *  them; see WRANGLER_PACKAGE for why its delete leaves them). One already gone is the expected case. */
async function deletePreview(cf: Cf, previewName: string, wrangler: string): Promise<void> {
  await deleteWorkerPreview(PREVIEW_PARENT, previewName, wrangler);
  await deleteDatabase(cf, previewResourceName(previewName, "db"));
  await deleteArtifactsNamespace(cf, previewResourceName(previewName, "repos"));
  const suffixes = previewResourceSuffixes();
  const kvNamespaces = await listAll<KvNamespaceRow>(cf, "/storage/kv/namespaces");
  for (const title of suffixes.kv.map((suffix) => previewResourceName(previewName, suffix))) {
    const row = kvNamespaces.find((namespace) => namespace.title === title);
    if (row) await deleteKvNamespace(cf, row);
    else console.warn(`KV namespace ${title} did not exist; continuing.`);
  }
  for (const suffix of suffixes.r2)
    await deleteR2Bucket(cf, previewResourceName(previewName, suffix));
}

/** os-next's preview and everything it owned, then every app on top's preview (whether or not it
 *  exists). */
async function deleteAll(cf: Cf, previewName: string): Promise<void> {
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    await deletePreview(cf, previewName, wrangler.command);
    for (const app of APPS)
      await deleteWorkerPreview(app.envs.preview!, previewName, wrangler.command);
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
 *  deployed-target mode against the preview, side by side — the same two suites deploy-os-next.yml
 *  and `pnpm spec` know. Each runner derives the deployed target itself
 *  (e2e/support/deployed-target.ts, from the `APP_CONFIG` in this process's environment and the
 *  parent's envs.ts entry): the vitest suite in its global-setup, the specs in specs/setup.ts. Every
 *  spec project runs, the notes project against this preview's Notes app (NOTES_BASE_URL; the Notes
 *  specs fail in CI without it). vitest streams; Playwright's report prints after it. */
async function runE2e(previewName: string): Promise<void> {
  const url = previewUrl(previewName);
  const env = { WORKER_BASE_URL: url, DEMO_BASE_URL: url };
  const notes = APPS.find((app) => app.name === "notes")!;
  const spec = (async () => {
    if (process.env.CI)
      await runAsync("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: path.resolve(ROOT, "../.."),
      });
    return run("pnpm", ["spec"], {
      cwd: path.resolve(ROOT, "../.."),
      env: {
        ...process.env,
        ...env,
        NOTES_BASE_URL: appPreviewUrl(notes, previewName),
        ...PREVIEW_SUITE_TELEMETRY.specs,
      },
    });
  })();
  // The deployed target needs no local Vite build. Keep the preview's built dist/ intact while
  // Playwright runs beside Vitest; the package's local `e2e` script intentionally rebuilds it.
  // The reporters are the `e2e` script's: the retry telemetry reporter records first attempts
  // that failed.
  const e2e = runAsync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--configLoader",
      "runner",
      "--project",
      "e2e",
      "--sequence.concurrent",
      "--reporter=default",
      "--reporter=../../packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts",
    ],
    { cwd: ROOT, env: { ...env, ...PREVIEW_SUITE_TELEMETRY["preview-e2e"] } },
  ).then(
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
  const failed = [!e2ePassed && "vitest e2e", specResult.status !== 0 && "pnpm spec"].filter(
    Boolean,
  );
  if (failed.length > 0) throw new Error(`${failed.join(" and ")} failed against ${url}`);
}

// ── after the suite: the residency gate, then the release ──────────────────────────────────────

/** A suite boundary the workflow recorded (`PREVIEW_SUITE_STARTED`, `PREVIEW_SUITE_ENDED`, UTC ISO). */
function suiteTime(name: string, fallback?: Date): Date {
  const value = process.env[name];
  if (!value && fallback) {
    console.warn(`${name} is unset (the e2e step never finished); using ${fallback.toISOString()}`);
    return fallback;
  }
  const time = new Date(requireEnv(name));
  if (Number.isNaN(time.getTime())) throw new Error(`${name}=${value} is not a time`);
  return time;
}

/** THE RESIDENCY GATE (the rules: scripts/preview-residency.ts). Waits until the analytics cover the
 *  window five minutes after the suite ended, reads which of the preview's Durable Objects were still
 *  resident, prints the verdict, writes it into the PR body, and fails on any leak. It only reads: a
 *  redeploy before it would end the very sessions it looks for, so `release` is the step after it. */
async function residencyGate(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  prNumber: string | undefined,
): Promise<void> {
  // A suite killed before its end was recorded ended no later than now: every client it had is gone.
  const suite = {
    started: suiteTime("PREVIEW_SUITE_STARTED"),
    ended: suiteTime("PREVIEW_SUITE_ENDED", new Date()),
  };
  const window = durableObjectResidencyWindow(suite.ended);
  const namespaces = previewDurableObjectNamespaces(
    z
      .array(DurableObjectNamespace)
      .parse(await listAll<unknown>(ctx.cf, "/workers/durable_objects/namespaces")),
    { parentWorkerName: PREVIEW_PARENT.workerName, previewName },
  );
  if (namespaces.length === 0)
    throw new Error(`no Durable Object namespace on the account belongs to preview ${previewName}`);
  const sleepUntil = (time: number) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, time - Date.now())));
  // A refused answer (a 5xx, a rate limit) is read again twice, 15 s apart, before it fails the gate.
  const read = async () => {
    for (let attempt = 1; ; attempt++) {
      const variables = durableObjectResidencyVariables({
        accountTag: PREVIEW_PARENT.cloudflareAccountId,
        namespaceIds: namespaces.map((namespace) => namespace.id),
        window,
        suite,
        readAt: new Date(),
      });
      const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: DURABLE_OBJECT_RESIDENCY_QUERY, variables }),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined; // an HTML error page (a 502 from the edge) is a refusal like any other
      }
      const answer = DurableObjectResidencyAnswer.safeParse(body);
      if (answer.success) return answer.data.data.viewer.accounts[0];
      const refusal = `Cloudflare GraphQL answered ${response.status}: ${text.slice(0, 1000)}`;
      if (attempt === 3) throw new Error(refusal);
      console.warn(`${refusal}; reading again in 15 s`);
      await sleepUntil(Date.now() + 15_000);
    }
  };
  // The window's last minute is complete about two minutes after the window ends (measured
  // 2026-09-23; durableObjectAnalyticsCoverWindow). An idle account reports no newer minute at all,
  // so the wait also ends five minutes after the window does.
  const firstRead = window.end.getTime() + 2 * 60_000;
  const deadline = window.end.getTime() + 5 * 60_000;
  console.log(
    `suite ${suite.started.toISOString()} → ${suite.ended.toISOString()}; reading the window ${window.start.toISOString()} → ${window.end.toISOString()} over ${namespaces.length} namespaces of ${previewName}, from ${new Date(firstRead).toISOString()}`,
  );
  await sleepUntil(firstRead);
  let account = await read();
  while (!durableObjectAnalyticsCoverWindow(account, window) && Date.now() < deadline) {
    await sleepUntil(Date.now() + 30_000);
    account = await read();
  }
  console.log(
    `the account's newest analytics minute: ${account.newestMinute[0]?.dimensions.datetimeMinute ?? "none since the window started"}`,
  );
  const verdict = durableObjectResidencyVerdict({ account, namespaces, window });
  console.log(`\n${renderDurableObjectResidency(verdict)}\n`);
  if (prNumber && process.env.GITHUB_TOKEN)
    await writePullRequestSection(
      prNumber,
      renderDurableObjectResidency(verdict, { maxRows: 40 }),
      RESIDENCY_SECTION_MARKERS,
    );
  if (verdict.failures.length > 0)
    throw new Error(`the residency gate failed: ${verdict.failures.join("; ")}`);
}

/** THE RELEASE: redeploy the preview from this checkout (the commit the run deployed, the same
 *  config), which ends the sessions the run left open instead of billing them until the next push.
 *  Measured on PR #2849's first run: 10 of 16 resident objects were gone within a minute; the 6 that
 *  are re-woken after a reset survived it, and the next run's gate names them again. The PR body
 *  keeps the deploy's section; only the deployment id behind the URL changes. */
async function releasePreview(
  ctx: EnvContext<OsEnv>,
  previewName: string,
  apps: StartApp[],
): Promise<void> {
  assertFreshInstall();
  await buildOsNext("preview");
  const { wrangler, deploymentId } = await deployOsPreview(ctx, previewName, apps);
  wrangler.cleanup();
  console.log(`released ${previewName}: redeployed as deployment ${deploymentId}`);
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
        "user-agent": "os-next-preview-sweep",
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
async function openPullRequestBranches(): Promise<string[] | undefined> {
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

const RESOURCE_KIND_LABELS: Record<SweptResource["kind"], string> = {
  kv: "KV namespace",
  r2: "R2 bucket",
  d1: "D1",
  artifacts: "Artifacts namespace",
};

/** The stale previews (deletePreview, and the apps on top of the same name) and the resources that
 *  outlived their preview, by the rules in scripts/preview-sweep.ts. */
async function sweep(cf: Cf, dryRun: boolean): Promise<void> {
  // The resources BEFORE the previews (rule 5): wrangler creates a preview before its KV and R2.
  const resources = await listSweptResources(cf);
  const previews = await listAll<ListedPreview>(
    cf,
    `/workers/workers/${PREVIEW_PARENT.workerName}/previews`,
  );
  console.log(
    `${previews.length} preview(s) on ${PREVIEW_PARENT.workerName}; ${resources.length} KV namespaces, R2 buckets, D1s and Artifacts namespaces to judge`,
  );
  // An app's preview without an os-next preview of the same name is a leftover of a failed delete.
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
  const workerNames = (await cf<{ id: string }[]>("/workers/scripts")).map((script) => script.id);
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
    for (const { name } of stale) {
      await deletePreview(cf, name, wrangler.command).catch((error) =>
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
          artifacts: () => deleteArtifactsNamespace(cf, orphan.name),
        }[orphan.kind];
        await deleteOrphan().catch((error) => failures.push(`${orphan.name}: ${describe(error)}`));
      }
    }
    for (const { app, name } of staleAppPreviews) {
      await deleteWorkerPreview(app.envs.preview!, name, wrangler.command).catch((error) =>
        failures.push(`apps/${app.name} ${name}: ${describe(error)}`),
      );
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
async function resolveBranch(pr: string | undefined, name: string | undefined): Promise<string> {
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
async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const pr = parsed.pr || process.env.PREVIEW_PR_NUMBER;
  const appsMode = parsed.apps || AppsMode.parse(process.env.PREVIEW_APPS || DEFAULT_APPS_MODE);
  if (parsed.command === "sweep") return sweep((await parentContext()).cf, parsed.dryRun);
  const branch = await resolveBranch(pr, parsed.name);
  const previewName = resolvePreviewName({ name: branch, prNumber: pr });
  console.log(`preview ${previewName} → ${previewUrl(previewName)}`);
  if (parsed.command === "config" || parsed.dryRun) {
    await buildOsNext("preview");
    console.log(`wrote ${writePreviewWranglerConfig({ previewName })}`);
    return;
  }
  if (parsed.command === "e2e") return runE2e(previewName);
  const ctx = await parentContext();
  if (parsed.command === "residency") return residencyGate(ctx, previewName, pr);
  if (parsed.command === "release")
    return releasePreview(ctx, previewName, await appsToPreview(appsMode, pr));
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
