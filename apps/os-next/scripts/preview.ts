// scripts/preview.ts — one Worker Preview per pull request of the one worker, the cloudflare-os recipe
// (their scripts/preview/preview.ts: eighteen workers in three tiers collapsed to one). The effects
// half; the pure half — naming, the PR body's section, the preview's wrangler config — is
// scripts/preview-config.ts (preview.test.ts). Commands: config (write wrangler.preview.jsonc),
// deploy (build, the D1 and the Artifacts namespace, the secrets, `wrangler preview`, the PR body),
// e2e (vitest and Playwright against the live preview), reset (delete, then deploy), delete (the
// preview, its D1 and Artifacts namespace, the apps on top), sweep (every preview whose PR is closed
// or missing, or older than 7 days, and the resources left behind). `--dry-run` prints the plan.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { osNextEnvs, type OsNextEnv } from "../../../envs.ts";
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
import { build } from "./build.ts";
import {
  APPS,
  changedApps,
  PREVIEW_CONFIG_NAME,
  PREVIEW_PARENT,
  previewNameOfResource,
  previewPullRequestNumber,
  previewResourceName,
  previewUrl,
  renderPullRequestSection,
  resolvePreviewName,
  splicePullRequestBody,
  writePreviewWranglerConfig,
} from "./preview-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");
/** cloudflare-os runs on this draft build too: released wrangler accepts a binding-only KV entry in
 *  `previews` but sends `namespace_id: undefined`; the branch of workers-sdk PR #14416 provisions a
 *  fresh KV namespace and R2 bucket per preview and deletes them with the preview. Drop this, and
 *  the tmpdir install below, once a released changelog mentions preview auto-provisioning. */
const WRANGLER_PACKAGE = "https://pkg.pr.new/wrangler@14416";

const Command = z.enum(["config", "deploy", "e2e", "reset", "delete", "sweep"]);
type Command = z.infer<typeof Command>;
/** The apps on top: every one, none, or (auto) the ones whose paths this PR changes. */
const AppsMode = z.enum(["all", "auto", "none"]);
type AppsMode = z.infer<typeof AppsMode>;
const USAGE = `Usage: preview.ts <${Command.options.join("|")}> [--pr <n>] [--name <ref>] [--apps ${AppsMode.options.join("|")}] [--dry-run]`;

/** The Cloudflare API on the parent's account (scripts/lib/env-context.ts: the envelope checked,
 *  429s retried, a truncated listing refused). */
type Cf = EnvContext<OsNextEnv>["cf"];

/** The parent's Doppler config (project-worker/preview), downloaded — the Cloudflare credentials for
 *  its account and the two secrets every preview inherits — the way ensure-resources and erase-data
 *  resolve theirs. Refuses a Doppler account that is not the parent's. */
const parentContext = () =>
  resolveEnvContext({ envs: osNextEnvs, dopplerProject: "project-worker", env: "preview" });

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
async function writePullRequestSection(prNumber: string, section: string): Promise<void> {
  const route = `/repos/${repository()}/pulls/${prNumber}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = (await github<{ body: string | null }>(route)).body || "";
    const body = splicePullRequestBody(before, section);
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

/** Create the preview's D1 if missing. The directory schema is the worker's own business — applied
 *  at boot, idempotent (src/control-plane.sql) — so a schema change is proven by the next request. */
async function ensureDatabase(cf: Cf, name: string): Promise<string> {
  const existing = await findDatabase(cf, name);
  const row =
    existing ||
    (await cf<D1Row>("/d1/database", { method: "POST", body: JSON.stringify({ name }) }));
  console.log(`${existing ? "found" : "created"} D1 ${name} (${row.uuid})`);
  return row.uuid;
}

async function deleteDatabase(cf: Cf, name: string): Promise<void> {
  const row = await findDatabase(cf, name);
  if (!row) return console.warn(`D1 ${name} did not exist; continuing.`);
  await cf(`/d1/database/${row.uuid}`, { method: "DELETE" });
  console.log(`deleted D1 ${name}`);
}

// ── the Artifacts namespace (not auto-provisioned: created here, deleted here) ─────────────────

type ArtifactsNamespaceRow = { namespace: string; repo_count?: number; created_at?: string };

/** Cloudflare's error envelope, the codes only — what an Artifacts refusal is told apart by. */
const CloudflareErrors = z.array(z.object({ code: z.number() }));

/** The Artifacts API's "does not exist": a 404 with code 10200 (measured; the one code for a
 *  namespace and for a repo). */
const isArtifactsNotFoundError = (error: unknown) =>
  error instanceof CloudflareApiError &&
  error.status === 404 &&
  (CloudflareErrors.safeParse(error.details).data ?? []).some((entry) => entry.code === 10200);

/** The API's refusal to delete a namespace that still holds repos: a 409 with code 10202 (measured). */
const isArtifactsNotEmptyError = (error: unknown) =>
  error instanceof CloudflareApiError &&
  error.status === 409 &&
  (CloudflareErrors.safeParse(error.details).data ?? []).some((entry) => entry.code === 10202);

/** A preview's namespace, by name. The worker's repo create does NOT provision one: on a missing
 *  namespace it fails with "Namespace is not active" (measured 2026-09-22), and the binding names
 *  the namespace only. */
async function ensureArtifactsNamespace(cf: Cf, artifactsNamespaceName: string): Promise<void> {
  const existing = await cf<ArtifactsNamespaceRow>(
    `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`,
  ).catch((error) => {
    if (isArtifactsNotFoundError(error)) return undefined;
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
  let deletedRepos = 0;
  for (let round = 1; ; round++) {
    if (round > 200)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} is still not empty after ${deletedRepos} repo deletes`,
      );
    // The first page, read again each round until it is empty — that is this loop's pagination, so
    // `page=1` is named (env-context refuses a truncated listing that names no page).
    const repos = await cf<{ name: string }[]>(`${route}/repos?limit=200&page=1`).catch((error) => {
      if (isArtifactsNotFoundError(error)) return undefined;
      throw error;
    });
    if (!repos)
      return console.warn(
        `Artifacts namespace ${artifactsNamespaceName} did not exist; continuing.`,
      );
    // ten at a time: one delete answers in ~1 s (measured), and a preview's e2e run leaves hundreds
    for (let i = 0; i < repos.length; i += 10) {
      await Promise.all(
        repos.slice(i, i + 10).map((repo) =>
          // one already gone (a delete accepted on an earlier round) is fine
          cf(`${route}/repos/${encodeURIComponent(repo.name)}`, { method: "DELETE" }).catch(
            (error) => {
              if (!isArtifactsNotFoundError(error)) throw error;
            },
          ),
        ),
      );
      deletedRepos += Math.min(10, repos.length - i);
    }
    if (repos.length > 0) continue;
    const deleted = await cf(route, { method: "DELETE" }).then(
      () => true,
      (error) => {
        if (!isArtifactsNotEmptyError(error)) throw error;
        return false;
      },
    );
    if (deleted) break;
    await new Promise((resolve) => setTimeout(resolve, 2000)); // accepted deletes still landing
  }
  console.log(`deleted Artifacts namespace ${artifactsNamespaceName} (${deletedRepos} repos)`);
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
async function uploadPreviewSecrets(wrangler: string, ctx: EnvContext<OsNextEnv>): Promise<void> {
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

async function deployPreview(
  ctx: EnvContext<OsNextEnv>,
  previewName: string,
  prNumber: string | undefined,
  apps: StartApp[],
) {
  assertFreshInstall();
  // The apps' vite builds run beside os-next's build, the D1 and the wrangler install.
  const appBuilds = Promise.all(apps.map((app) => buildStartApp(app, "preview")));
  await build();
  const databaseId = await ensureDatabase(ctx.cf, previewResourceName(previewName, "db"));
  await ensureArtifactsNamespace(ctx.cf, previewResourceName(previewName, "repos"));
  writePreviewWranglerConfig({ previewName, d1DatabaseId: databaseId });
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
    await appBuilds;
    const appPreviews = await Promise.all(
      apps.map((app) => deployAppPreview(app, previewName, url, wrangler.command)),
    );
    const slug = data.preview?.slug || previewName;
    const summary = {
      previewName,
      url,
      deploymentId,
      slug,
      dashboardUrl: `https://dash.cloudflare.com/${PREVIEW_PARENT.cloudflareAccountId}/workers/services/view/${PREVIEW_PARENT.workerName}/production/previews/${slug}`,
      apps: appPreviews,
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

/** The preview, then its D1 and its Artifacts namespace (wrangler deletes the auto-provisioned KV
 *  and R2 with the preview; these two it never knew). */
async function deletePreview(cf: Cf, previewName: string, wrangler: string): Promise<void> {
  await deleteWorkerPreview(PREVIEW_PARENT, previewName, wrangler);
  await deleteDatabase(cf, previewResourceName(previewName, "db"));
  await deleteArtifactsNamespace(cf, previewResourceName(previewName, "repos"));
}

/** os-next's preview, its D1 and its Artifacts namespace, then every app on top's preview (whether
 *  or not it exists). */
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

/** THE PROOF: the vitest e2e suite and the Playwright specs, both in deployed-target mode against
 *  the preview, side by side — the same two suites deploy-os-next.yml and `pnpm spec` know. Each
 *  runner derives the deployed target itself (e2e/support/deployed-target.ts, from the `APP_CONFIG`
 *  in this process's environment and the parent's envs.ts entry): the vitest suite in its
 *  global-setup, the specs in playwright.config.ts. vitest streams; Playwright's report prints
 *  after it. */
async function runE2e(previewName: string): Promise<void> {
  const url = previewUrl(previewName);
  const env = { WORKER_BASE_URL: url, DEMO_BASE_URL: url };
  const spec = (async () => {
    if (process.env.CI)
      await runAsync("pnpm", ["exec", "playwright", "install", "chromium"], { cwd: ROOT });
    return run("pnpm", ["spec"], { env: { ...process.env, ...env } });
  })();
  const e2e = runAsync("pnpm", ["e2e"], { cwd: ROOT, env }).then(
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
  const failed = [!e2ePassed && "pnpm e2e", specResult.status !== 0 && "pnpm spec"].filter(Boolean);
  if (failed.length > 0) throw new Error(`${failed.join(" and ")} failed against ${url}`);
}

// ── sweep (cloudflare-os: GitHub has no `environment.auto_stop_in`) ────────────────────────────

type PullRequestState = "open" | "closed" | "missing" | "unknown";

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

type ListedPreview = { name: string; slug?: string; created_on?: string; modified_on?: string };

async function sweep(cf: Cf, dryRun: boolean): Promise<void> {
  const previews = await listAll<ListedPreview>(
    cf,
    `/workers/workers/${PREVIEW_PARENT.workerName}/previews`,
  );
  console.log(`${previews.length} preview(s) on ${PREVIEW_PARENT.workerName}`);
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
  const stale: { name: string; reasons: string[] }[] = [];
  for (const preview of previews) {
    const reasons: string[] = [];
    const stamp = preview.created_on || preview.modified_on;
    const age = stamp ? (Date.now() - Date.parse(stamp)) / 86_400_000 : NaN;
    if (age > 7) reasons.push(`${age.toFixed(1)} days old`);
    const number = previewPullRequestNumber(preview.name);
    const state = number === undefined ? "unknown" : await pullRequestState(number);
    if (state === "closed") reasons.push("its pull request is closed");
    if (state === "missing") reasons.push("it names no pull request in this repository");
    if (reasons.length > 0) stale.push({ name: preview.name, reasons });
    else
      console.log(
        `  keep ${preview.name} (${state}, ${Number.isNaN(age) ? "age unknown" : `${age.toFixed(1)} days`})`,
      );
  }
  // A D1 whose preview is gone (a cleanup that failed after `preview delete`, a hand-deleted preview).
  const live = new Set(previews.map((preview) => previewResourceName(preview.name, "db")));
  // A D1 named for a preview that no longer exists — but only when its pull request is closed or
  // missing, or the database is older than a day: a deploy in flight creates its D1 BEFORE the
  // preview exists, and a sweep running at that moment must not take it.
  const orphanDatabases: D1Row[] = [];
  for (const row of await listAll<D1Row>(cf, "/d1/database")) {
    const previewName = previewNameOfResource(row.name, "db");
    if (!previewName?.startsWith("pr") || live.has(row.name)) continue;
    const number = previewPullRequestNumber(previewName);
    const state = number === undefined ? "unknown" : await pullRequestState(number);
    const ageDays = row.created_at ? (Date.now() - Date.parse(row.created_at)) / 86_400_000 : NaN;
    if (state === "closed" || state === "missing" || ageDays > 1) orphanDatabases.push(row);
  }
  // An Artifacts namespace whose preview is gone, judged exactly as the D1 is (the deploy creates
  // both before the preview exists; deletePreview takes both with it): one still here outlived a
  // failed delete, or a delete from before this script deleted namespaces (2026-09-22).
  const liveArtifactsNamespaces = new Set(
    previews.map((preview) => previewResourceName(preview.name, "repos")),
  );
  const orphanArtifactsNamespaces: ArtifactsNamespaceRow[] = [];
  for (const row of await listAll<ArtifactsNamespaceRow>(cf, "/artifacts/namespaces")) {
    const previewName = previewNameOfResource(row.namespace, "repos");
    if (!previewName?.startsWith("pr") || liveArtifactsNamespaces.has(row.namespace)) continue;
    const number = previewPullRequestNumber(previewName);
    const state = number === undefined ? "unknown" : await pullRequestState(number);
    const ageDays = row.created_at ? (Date.now() - Date.parse(row.created_at)) / 86_400_000 : NaN;
    if (state === "closed" || state === "missing" || ageDays > 1)
      orphanArtifactsNamespaces.push(row);
  }
  const staleNames = new Set(stale.map(({ name }) => name));
  const liveNames = new Set(previews.map((preview) => preview.name));
  const staleAppPreviews = appPreviews.filter(
    ({ name }) => staleNames.has(name) || !liveNames.has(name),
  );
  for (const { name, reasons } of stale) console.log(`  delete ${name}: ${reasons.join("; ")}`);
  for (const row of orphanDatabases) console.log(`  delete orphan D1 ${row.name}`);
  for (const row of orphanArtifactsNamespaces)
    console.log(
      `  delete orphan Artifacts namespace ${row.namespace} (${row.repo_count ?? "?"} repos)`,
    );
  for (const { app, name } of staleAppPreviews)
    console.log(`  delete apps/${app.name} preview ${name}`);
  if (
    dryRun ||
    (stale.length === 0 &&
      orphanDatabases.length === 0 &&
      orphanArtifactsNamespaces.length === 0 &&
      staleAppPreviews.length === 0)
  )
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
    for (const row of orphanDatabases) {
      await cf(`/d1/database/${row.uuid}`, { method: "DELETE" }).catch((error) =>
        failures.push(`${row.name}: ${describe(error)}`),
      );
    }
    for (const row of orphanArtifactsNamespaces) {
      await deleteArtifactsNamespace(cf, row.namespace).catch((error) =>
        failures.push(`${row.namespace}: ${describe(error)}`),
      );
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

/** The flags, then the workflow's spellings — PREVIEW_PR_NUMBER, PREVIEW_APPS (auto | all | none),
 *  PREVIEW_NAME (resolveBranch) — then the defaults. */
async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const pr = parsed.pr || process.env.PREVIEW_PR_NUMBER;
  const appsMode = parsed.apps || AppsMode.parse(process.env.PREVIEW_APPS || "auto");
  if (parsed.command === "sweep") return sweep((await parentContext()).cf, parsed.dryRun);
  const branch = await resolveBranch(pr, parsed.name);
  const previewName = resolvePreviewName({ name: branch, prNumber: pr });
  console.log(
    `preview ${previewName} → ${previewUrl(previewName)} (D1 ${previewResourceName(previewName, "db")})`,
  );
  if (parsed.command === "config" || parsed.dryRun) {
    console.log(
      `wrote ${writePreviewWranglerConfig({ previewName, d1DatabaseId: "<created at deploy>" })}`,
    );
    return;
  }
  if (parsed.command === "e2e") return runE2e(previewName);
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
