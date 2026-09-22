// scripts/preview.ts — ONE PREVIEW PER PULL REQUEST of the one worker, on Cloudflare Worker Previews.
//
// Cribbed from cloudflare/cloudflare-os (`scripts/preview/preview.ts` + `staging-config.ts` there):
// their eighteen workers in three tiers collapse to one here, everything else keeps their shape —
// the preview name, the pkg.pr.new wrangler, the secrets path, the nightly sweep, the tolerated
// not-found on delete.
//
//   pnpm preview config  --pr <n> [--name <ref>]   write wrangler.preview.jsonc only
//   ... --apps all|auto|none                    the apps on top (dash, agents, notes, voice): auto
//                                                  (default) previews the ones whose paths changed
//                                                  since the merge-base, all previews every one
//   pnpm preview deploy  --pr <n>                  build, ensure the D1 and the Artifacts namespace,
//                                                  upload secrets, `wrangler preview`, then write the
//                                                  PR body's preview section
//   pnpm preview e2e     --pr <n>                  the vitest e2e suite AND the Playwright specs
//                                                  (pnpm e2e, pnpm spec) against the live preview
//   pnpm preview reset   --pr <n>                  delete, then deploy from scratch — THE answer to
//                                                  "something is wrong with my preview"
//   pnpm preview delete  --pr <n>                  tear it down: the preview, then its D1 and its
//                                                  Artifacts namespace
//   pnpm preview sweep                             delete every preview whose PR is closed or missing,
//                                                  or that is older than 7 days, and every D1 and
//                                                  Artifacts namespace left behind by one
//   ... --dry-run                                  print the plan, touch no network
//
// A Worker Preview is a branch of an existing worker, THE PARENT (generate-wrangler-config.ts
// PREVIEW_PARENT: os-next-preview on the dev/preview account; nothing reads its data). One preview per
// PR, `pr<n>-<branch slug>` as cloudflare-os names theirs, redeployed in place on every push, with
// Durable Object namespaces, KV, R2, D1 and an Artifacts namespace of its own. The apps on top —
// dash, agents, notes, voice — are OAuth clients and nothing else: each gets a preview of its own
// parent under the same name, its one var the issuer, this PR's os-next preview (README, "Previews").
//
// Environment: Doppler project-worker/preview (CLOUDFLARE_API_TOKEN + ACCOUNT_ID for the parent's
// account; APP_CONFIG + APP_CONFIG_SECRETS__KEY, the two secrets every preview inherits), PREVIEW_NAME + PREVIEW_PR_NUMBER
// (the branch and the PR; flags override), GITHUB_TOKEN + GITHUB_REPOSITORY (the PR body and the
// sweep's PR lookups), PREVIEW_WRANGLER (a wrangler binary instead of the pinned one).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { agents } from "../../agents/scripts/app.ts";
import { dash } from "../../dash/scripts/app.ts";
import { notes } from "../../notes/scripts/app.ts";
import { voice } from "../../voice/scripts/app.ts";
import {
  buildStartApp,
  writeStartAppPreviewConfig,
  type StartApp,
} from "../../../scripts/lib/start-app.ts";
import { build } from "./build.ts";
import {
  PREVIEW_PARENT,
  PREVIEW_CONFIG_NAME,
  previewNameOfResource,
  previewResourceName,
  previewUrl,
  writePreviewWranglerConfig,
} from "./generate-wrangler-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");
/** cloudflare-os runs on this draft build too: released wrangler accepts a binding-only KV entry in
 *  `previews` but sends `namespace_id: undefined`; the branch of workers-sdk PR #14416 provisions a
 *  fresh KV namespace and R2 bucket per preview and deletes them with the preview. Drop this, and
 *  the tmpdir install below, once a released changelog mentions preview auto-provisioning. */
const WRANGLER_PACKAGE = "https://pkg.pr.new/wrangler@14416";
/** cloudflare-os's limit: the slug is the URL's first label, and KV/R2 names carry it too. */
export const MAX_PREVIEW_NAME_LENGTH = 28;

/** The apps on top, each previewed from its own parent worker (envs.ts `<app>Envs.preview`). */
export const APPS: StartApp[] = [dash, agents, notes, voice];
/** A path that changes every app: the SDK they are built on, the shared UI, the shared deploy
 *  scripts, the env map. An app's own paths are `apps/<name>/`. */
export const SHARED_APP_PATHS = ["packages/iterate/", "packages/ui/", "scripts/lib/", "envs.ts"];

type Command = "config" | "deploy" | "e2e" | "reset" | "delete" | "sweep";
const COMMANDS: Command[] = ["config", "deploy", "e2e", "reset", "delete", "sweep"];
const USAGE = `Usage: preview.ts <${COMMANDS.join("|")}> [--pr <n>] [--name <ref>] [--apps all|auto|none] [--dry-run]`;

// ── naming (pure; preview.test.ts) ─────────────────────────────────────────────────────────────

/** Slugify a ref into a legal preview name, truncating with a stable hash (cloudflare-os). */
export function slugifyPreviewName(
  raw: string,
  { reserve = 0 }: { reserve?: number } = {},
): string {
  const budget = MAX_PREVIEW_NAME_LENGTH - reserve;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "preview";
  if (slug.length <= budget) return slug;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 6);
  return `${slug.slice(0, budget - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

/** `pr<n>-<branch slug>`: recognizable, unique per pull request. Two live branches can slugify to
 *  one name (`feature/foo`, `feature-foo`) and would otherwise share an instance. Without a number
 *  — a local run — the bare slug, which the sweep judges on age alone. */
export function resolvePreviewName({
  name = process.env.PREVIEW_NAME,
  prNumber = process.env.PREVIEW_PR_NUMBER,
}: { name?: string; prNumber?: string } = {}): string {
  if (!name) throw new Error("a preview needs a ref: --name <ref> or PREVIEW_NAME");
  const pr = (prNumber || "").trim();
  if (!/^\d+$/.test(pr)) return slugifyPreviewName(name);
  const prefix = `pr${pr}-`;
  return `${prefix}${slugifyPreviewName(name, { reserve: prefix.length })}`;
}

export function previewPullRequestNumber(previewName: string): number | undefined {
  const match = /^pr(\d+)-/.exec(previewName);
  return match ? Number(match[1]) : undefined;
}

/** Which apps on top a set of changed paths touches: an app's own directory, or a shared path
 *  (then every app). Pure; preview.test.ts. */
export function changedApps(changedPaths: string[], apps: StartApp[] = APPS): StartApp[] {
  if (changedPaths.some((file) => SHARED_APP_PATHS.some((shared) => file.startsWith(shared))))
    return apps;
  return apps.filter((app) => changedPaths.some((file) => file.startsWith(`apps/${app.name}/`)));
}

// ── the PR body's managed section (pure; preview.test.ts) ──────────────────────────────────────

const SECTION_BEGIN = "<!-- os-next-preview:begin -->";
const SECTION_END = "<!-- os-next-preview:end -->";

/** Replace the managed section between the markers, or append one. Everything a person wrote
 *  around it is kept verbatim. */
export function splicePullRequestBody(body: string, section: string): string {
  const block = `${SECTION_BEGIN}\n${section.trim()}\n${SECTION_END}`;
  const begin = body.indexOf(SECTION_BEGIN);
  const end = body.indexOf(SECTION_END, begin);
  if (begin >= 0 && end > begin) {
    return body.slice(0, begin) + block + body.slice(end + SECTION_END.length);
  }
  const kept = body.trimEnd();
  return `${kept ? `${kept}\n\n` : ""}${block}\n`;
}

export function renderPullRequestSection(input: {
  previewName: string;
  url: string;
  deploymentId: string;
  dashboardUrl: string;
  prNumber: string;
  branch: string;
  /** The apps on top previewed this run, by name, with their URLs. */
  apps: { name: string; url: string }[];
}): string {
  const dispatch = (action: string) =>
    `depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os-next.yml --ref ${input.branch} --input pull-request-number=${input.prNumber} --input action=${action}`;
  const local = (command: string) =>
    `doppler run --project project-worker --config preview -- pnpm preview ${command} --pr ${input.prNumber} --name ${input.branch}`;
  return [
    `### os-next preview: \`${input.previewName}\``,
    "",
    `**${input.url}** · deployment \`${input.deploymentId.slice(0, 8)}\` · [Cloudflare dashboard](${input.dashboardUrl}) · deleted when this PR closes`,
    "",
    ...(input.apps.length > 0
      ? [
          "| App on top, signed in against this preview | |",
          "| --- | --- |",
          ...input.apps.map((app) => `| ${app.name} | ${app.url} |`),
          "",
        ]
      : [
          "No app on top changed in this PR (dash, agents, notes, voice deploy only when their own paths change; `--input apps=all` previews every one).",
          "",
        ]),
    "<details><summary>Preview operations (the cloudflare-os recipe)</summary>",
    "",
    "Every push redeploys the preview in place; its data carries over. When anything about it is wrong, reset it.",
    "",
    "| From CI | |",
    "| --- | --- |",
    `| Reset — destroy and redeploy from scratch | \`${dispatch("reset")}\` |`,
    `| Re-run the e2e suite against the live preview | \`${dispatch("e2e")}\` |`,
    `| Redeploy without a push | \`${dispatch("deploy")}\` |`,
    `| Redeploy with every app on top | \`${dispatch("deploy")} --input apps=all\` |`,
    `| Delete | \`${dispatch("delete")}\` |`,
    "",
    "| From a laptop (needs Doppler; run in `apps/os-next`) | |",
    "| --- | --- |",
    `| Reset | \`${local("reset")}\` |`,
    `| e2e | \`${local("e2e")}\` |`,
    `| Deploy | \`${local("deploy")}\` |`,
    `| Delete | \`${local("delete")}\` |`,
    "",
    "Previews route projects by paths on their workers.dev origin (`/projects/<slug>/<app>/…`), so the e2e rows that dial a subdomain skip.",
    "",
    "</details>",
  ].join("\n");
}

// ── process helpers (cloudflare-os) ────────────────────────────────────────────────────────────

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a command. `inherit`: the child's output streams through (builds, installs); otherwise it is
 *  captured and returned — wrangler's `--json` payload, its prose for a not-found check. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): Promise<CommandResult> {
  console.log(
    `running${options.cwd ? ` in ${path.relative(ROOT, options.cwd) || "."}` : ""}: ${command} ${args.join(" ")}`,
  );
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => (stdout += data));
    child.stderr?.on("data", (data: string) => (stderr += data));
    child.once("error", (error) => reject(new Error(`failed to run ${command}: ${error.message}`)));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** `run`, failing loudly on a non-zero exit. */
async function runOk(command: string, args: string[], options?: Parameters<typeof run>[2]) {
  const result = await run(command, args, options);
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stderr}`,
    );
  return result;
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
    ready: runOk("pnpm", ["--config.blockExoticSubdeps=false", "--dir", installDir, "install"], {
      inherit: true,
    }).then(() => {}),
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

// ── Cloudflare + GitHub over fetch ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function cf<T = unknown>(
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method: init.method || "GET",
    headers: {
      authorization: `Bearer ${requireEnv("CLOUDFLARE_API_TOKEN")}`,
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  // Cloudflare's v4 envelope: `{ success, errors, result }` on every route; a non-JSON body (a 5xx
  // page) becomes `{}` and fails the `success` check below. `result` is whatever the caller declared
  // for its route — the routes here are read-mostly and their shapes are pinned by use.
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: unknown;
    result?: T;
  };
  if (!response.ok || payload.success === false) {
    throw new Error(
      `Cloudflare ${init.method || "GET"} ${route} failed with ${response.status}: ${JSON.stringify(payload.errors ?? payload)}`,
    );
  }
  return payload.result as T; // the caller's declared route shape (see above)
}

const account = () => {
  const id = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  if (id !== PREVIEW_PARENT.cloudflareAccountId) {
    throw new Error(
      `CLOUDFLARE_ACCOUNT_ID ${id} is not the parent worker's account ${PREVIEW_PARENT.cloudflareAccountId} (Doppler project-worker/preview)`,
    );
  }
  return id;
};

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

/** Every D1 on the account (the list API's `name` filter matches by prefix — measured — so the exact
 *  match is made here, and the sweep filters by prefix here too). */
async function listDatabases(): Promise<D1Row[]> {
  const rows: D1Row[] = [];
  for (let page = 1; ; page++) {
    const batch = await cf<D1Row[]>(`/accounts/${account()}/d1/database?per_page=100&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

async function findDatabase(name: string): Promise<D1Row | undefined> {
  return (await listDatabases()).find((row) => row.name === name);
}

/** Create the preview's D1 if missing. The directory schema is the worker's own business — applied
 *  at boot, idempotent (src/control-plane.sql) — so a schema change is proven by the next request. */
async function ensureDatabase(name: string): Promise<string> {
  const existing = await findDatabase(name);
  const row =
    existing ||
    (await cf<D1Row>(`/accounts/${account()}/d1/database`, { method: "POST", body: { name } }));
  console.log(`${existing ? "found" : "created"} D1 ${name} (${row.uuid})`);
  return row.uuid;
}

async function deleteDatabase(name: string): Promise<void> {
  const row = await findDatabase(name);
  if (!row) return console.warn(`D1 ${name} did not exist; continuing.`);
  await cf(`/accounts/${account()}/d1/database/${row.uuid}`, { method: "DELETE" });
  console.log(`deleted D1 ${name}`);
}

// ── the Artifacts namespace (not auto-provisioned: created here, deleted here) ─────────────────

type ArtifactsNamespaceRow = { namespace: string; repo_count?: number; created_at?: string };

/** A preview's namespace, by name. The worker's repo create does NOT provision one: on a missing
 *  namespace it fails with "Namespace is not active" (measured 2026-09-22), and the binding names
 *  the namespace only. */
async function ensureArtifactsNamespace(artifactsNamespaceName: string): Promise<void> {
  const route = `/accounts/${account()}/artifacts/namespaces`;
  const existing = await cf<ArtifactsNamespaceRow>(
    `${route}/${encodeURIComponent(artifactsNamespaceName)}`,
  ).catch((error) => {
    if (isArtifactsNotFoundError(error)) return undefined;
    throw error;
  });
  if (!existing) await cf(route, { method: "POST", body: { namespace: artifactsNamespaceName } });
  console.log(`${existing ? "found" : "created"} Artifacts namespace ${artifactsNamespaceName}`);
}

/** Every Artifacts namespace on the account (the list pages like D1's). */
async function listArtifactsNamespaces(): Promise<ArtifactsNamespaceRow[]> {
  const rows: ArtifactsNamespaceRow[] = [];
  for (let page = 1; ; page++) {
    const batch = await cf<ArtifactsNamespaceRow[]>(
      `/accounts/${account()}/artifacts/namespaces?per_page=100&page=${page}`,
    );
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

/** The Artifacts API's "does not exist": a 404 with code 10200 (measured; the one code for a
 *  namespace and for a repo), as `cf` reports it — the status, then the errors as JSON. */
const isArtifactsNotFoundError = (error: unknown) =>
  /failed with 404\b/.test(describe(error)) && /"code":10200\b/.test(describe(error));

/** The API's refusal to delete a namespace that still holds repos: a 409 with code 10202 (measured). */
const isArtifactsNotEmptyError = (error: unknown) =>
  /failed with 409\b/.test(describe(error)) && /"code":10202\b/.test(describe(error));

/** Delete a preview's Artifacts namespace: every repo first (the API refuses a namespace that is
 *  not empty), then the namespace. A repo delete is ACCEPTED (202) and lands after the answer, so
 *  the list is read again until it is empty and the namespace delete stops answering "not empty";
 *  a ceiling keeps that bounded. A namespace that does not exist — a preview deleted before its
 *  deploy created one, a re-run of the cleanup job, the sweep racing the close job — is the
 *  expected case. */
async function deleteArtifactsNamespace(artifactsNamespaceName: string): Promise<void> {
  const route = `/accounts/${account()}/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`;
  let deletedRepos = 0;
  for (let round = 1; ; round++) {
    if (round > 200)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} is still not empty after ${deletedRepos} repo deletes`,
      );
    const repos = await cf<{ name: string }[]>(`${route}/repos?limit=200`).catch((error) => {
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
  console.log(`running in apps/${app.name}: wrangler ${previewArgs.join(" ")}`);
  let result = await run(wrangler, previewArgs, { cwd: root });
  if (result.status !== 0 && isMissingWorkerError(`${result.stdout}\n${result.stderr}`)) {
    console.log(`apps/${app.name}: parent worker missing; running: wrangler deploy -c ${config}`);
    const deployed = await run(wrangler, ["deploy", "-c", config], { cwd: root });
    if (deployed.status !== 0)
      throw new Error(`apps/${app.name}: wrangler deploy of the parent failed\n${deployed.stderr}`);
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
  await waitFor(`${url}/healthz`, (status) => status === 200);
  return { name: app.name, url };
}

/** The apps this run previews: --apps all, none, or (auto) the ones whose paths this PR changes. */
async function appsToPreview(
  mode: "all" | "auto" | "none",
  prNumber: string | undefined,
): Promise<StartApp[]> {
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

/** Delete an app's preview; a preview (or parent) that never existed is the expected case. */
async function deleteAppPreview(
  app: StartApp,
  previewName: string,
  wrangler: string,
): Promise<void> {
  const config = writeParentConfig(app.envs.preview!);
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
    if (result.status === 0) return console.log(`apps/${app.name}: deleted preview ${previewName}`);
    const output = `${result.stdout}\n${result.stderr}`;
    if (/not found|does not exist|10007|10025|10222/i.test(output))
      return console.warn(`apps/${app.name}: preview ${previewName} did not exist; continuing.`);
    throw new Error(
      `apps/${app.name}: wrangler preview delete failed with exit code ${result.status}\n${result.stderr}`,
    );
  } finally {
    rmSync(path.dirname(config), { recursive: true, force: true });
  }
}

// ── the preview itself ─────────────────────────────────────────────────────────────────────────

/** `preview secret bulk` writes the WORKER's Previews settings, which every preview of it inherits:
 *  one upload covers every preview, and each run refreshes them. The two secrets are the deployment's
 *  (src/app-config.ts): the one `APP_CONFIG` object — `login.password`, `secrets.adminBearer` — and
 *  `APP_CONFIG_SECRETS__KEY` beside it. Values go through a 0600 tmp file, never argv or the config. */
async function uploadPreviewSecrets(wrangler: string): Promise<void> {
  const secrets = Object.fromEntries(
    ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"].map((name) => [name, requireEnv(name)]),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "os-next-preview-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    await runOk(wrangler, ["preview", "secret", "bulk", file, "-c", PREVIEW_CONFIG_NAME]);
    console.log(
      `uploaded ${Object.keys(secrets).length} secrets to the Previews settings of ${PREVIEW_PARENT.workerName}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Wait for a URL to answer as expected — propagation was observed at a few seconds; 90 s is the
 *  budget deploy-helpers uses. os-next's smoke is `/version` naming the new deployment (src/worker.ts);
 *  an app's is `/healthz`. */
async function waitFor(url: string, ok: (status: number, text: string) => boolean): Promise<void> {
  for (let attempt = 1; attempt <= 18; attempt++) {
    const response = await fetch(url).catch(() => null);
    const text = (await response?.text().catch(() => "")) || "";
    if (response && ok(response.status, text))
      return console.log(`${url} answers ${text.trim() || response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${url} never answered as expected`);
}

/** A laptop deploy bundles whatever node_modules holds. After a merge that changed pnpm-lock.yaml a
 *  stale install ships the OLD dependency — 2026-09-21 a since-removed pnpm patch was missing from
 *  the bundle and every session the preview minted was refused at /api. CI runs `pnpm install`
 *  first; a laptop is told to. */
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
  previewName: string,
  prNumber: string | undefined,
  branch: string,
  apps: StartApp[],
) {
  assertFreshInstall();
  // The apps' vite builds run beside os-next's build, the D1 and the wrangler install.
  const appBuilds = Promise.all(apps.map((app) => buildStartApp(app, "preview")));
  await build();
  const databaseId = await ensureDatabase(previewResourceName(previewName, "db"));
  await ensureArtifactsNamespace(previewResourceName(previewName, "repos"));
  writePreviewWranglerConfig({ previewName, d1DatabaseId: databaseId });
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    await uploadPreviewSecrets(wrangler.command);
    console.log(`running: wrangler preview --name ${previewName} -c ${PREVIEW_CONFIG_NAME} --json`);
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
      const hint = /This Worker does not exist|10007/i.test(`${result.stdout}\n${result.stderr}`)
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
    await waitFor(
      `${url}/version`,
      (status, text) => status === 200 && text.startsWith(deploymentId),
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
    if (prNumber && process.env.GITHUB_TOKEN) {
      await writePullRequestSection(
        prNumber,
        renderPullRequestSection({ ...summary, prNumber, branch }),
      );
    }
  } finally {
    wrangler.cleanup();
  }
}

/** The preview, then its D1 and its Artifacts namespace (wrangler deletes the auto-provisioned KV
 *  and R2 with the preview; these two it never knew). Deleting a preview that was never created —
 *  a PR closed before its first deploy, a re-run of the cleanup job, the sweep racing the close job
 *  — is the expected case, not a failure. */
async function deletePreview(previewName: string, wranglerCommand?: string): Promise<void> {
  const config = writeParentConfig(PREVIEW_PARENT);
  const wrangler = wranglerCommand
    ? { command: wranglerCommand, ready: Promise.resolve(), cleanup: () => {} }
    : preparePreviewWrangler();
  try {
    await wrangler.ready;
    const result = await run(wrangler.command, [
      "preview",
      "delete",
      "--name",
      previewName,
      "-c",
      config,
      "-y",
    ]);
    if (result.status === 0) console.log(`deleted preview ${previewName}`);
    else if (
      /not found|does not exist|10007|10025|10222/i.test(`${result.stdout}\n${result.stderr}`)
    )
      console.warn(`preview ${previewName} did not exist; continuing.`);
    else
      throw new Error(
        `wrangler preview delete failed with exit code ${result.status}\n${result.stderr}`,
      );
  } finally {
    wrangler.cleanup();
    rmSync(path.dirname(config), { recursive: true, force: true });
  }
  await deleteDatabase(previewResourceName(previewName, "db"));
  await deleteArtifactsNamespace(previewResourceName(previewName, "repos"));
}

/** os-next's preview, its D1 and its Artifacts namespace, then every app on top's preview (whether
 *  or not it exists). */
async function deleteAll(previewName: string): Promise<void> {
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    await deletePreview(previewName, wrangler.command);
    for (const app of APPS) await deleteAppPreview(app, previewName, wrangler.command);
  } finally {
    wrangler.cleanup();
  }
}

/** THE PROOF: the vitest e2e suite and the Playwright specs, both in deployed-target mode against
 *  the preview, side by side — the same two suites deploy-os-next.yml and `pnpm spec` know
 *  (e2e/support/global-setup.ts, playwright.config.ts). The admin bearer and the sign-in password
 *  are read out of the deployment's `APP_CONFIG` (secrets.adminBearer, login.password); the preview
 *  routes projects by paths, so the rows that dial a subdomain skip. vitest streams; Playwright's
 *  report prints after it. */
async function runE2e(previewName: string): Promise<void> {
  const url = previewUrl(previewName);
  // The deployment's own object (src/app-config.ts), as Doppler holds it.
  const appConfig = JSON.parse(requireEnv("APP_CONFIG")) as {
    login: { password: string };
    secrets: { adminBearer: string };
  };
  const env = {
    ...process.env,
    WORKER_BASE_URL: url,
    DEMO_BASE_URL: url,
    ADMIN_API_SECRET: appConfig.secrets.adminBearer,
    LOGIN_PASSWORD: appConfig.login.password,
    PROJECT_INGRESS_ROUTING: JSON.stringify(PREVIEW_PARENT.ingressRouting),
    MCP_BASE_URL: `${url}/mcp`,
  };
  const spec = (async () => {
    if (process.env.CI) await runOk("pnpm", ["exec", "playwright", "install", "chromium"], { env });
    return run("pnpm", ["spec"], { env });
  })();
  const e2e = run("pnpm", ["e2e"], { env, inherit: true });
  const [specResult, e2eResult] = await Promise.all([spec, e2e]);
  process.stdout.write(
    `\n── playwright (pnpm spec) ──\n${specResult.stdout}${specResult.stderr}\n`,
  );
  const failed = [
    e2eResult.status !== 0 && "pnpm e2e",
    specResult.status !== 0 && "pnpm spec",
  ].filter(Boolean);
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

async function sweep(dryRun: boolean): Promise<void> {
  const previews = await cf<ListedPreview[]>(
    `/accounts/${account()}/workers/workers/${PREVIEW_PARENT.workerName}/previews`,
  );
  console.log(`${previews.length} preview(s) on ${PREVIEW_PARENT.workerName}`);
  // An app's preview without an os-next preview of the same name is a leftover of a failed delete.
  const appPreviews: { app: StartApp; name: string }[] = [];
  for (const app of APPS) {
    const parent = app.envs.preview!.workerName;
    const listed = await cf<ListedPreview[]>(
      `/accounts/${account()}/workers/workers/${parent}/previews`,
    ).catch((error) => {
      if (!isMissingWorkerError(describe(error))) throw error;
      return [] as ListedPreview[]; // a parent never deployed holds no previews
    });
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
  for (const row of await listDatabases()) {
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
  for (const row of await listArtifactsNamespaces()) {
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
      await deletePreview(name, wrangler.command).catch((error) =>
        failures.push(`${name}: ${describe(error)}`),
      );
    }
    for (const row of orphanDatabases) {
      await cf(`/accounts/${account()}/d1/database/${row.uuid}`, { method: "DELETE" }).catch(
        (error) => failures.push(`${row.name}: ${describe(error)}`),
      );
    }
    for (const row of orphanArtifactsNamespaces) {
      await deleteArtifactsNamespace(row.namespace).catch((error) =>
        failures.push(`${row.namespace}: ${describe(error)}`),
      );
    }
    for (const { app, name } of staleAppPreviews) {
      await deleteAppPreview(app, name, wrangler.command).catch((error) =>
        failures.push(`apps/${app.name} ${name}: ${describe(error)}`),
      );
    }
    if (failures.length > 0) throw new Error(`sweep failures:\n  ${failures.join("\n  ")}`);
  } finally {
    wrangler.cleanup();
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const command = argv[0] as Command; // validated on the next line: anything not in COMMANDS is refused
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  let pr: string | undefined;
  let name: string | undefined;
  let apps: "all" | "auto" | "none" = "auto";
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--pr") pr = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--apps") {
      const mode = argv[++i];
      if (mode !== "all" && mode !== "auto" && mode !== "none") throw new Error(USAGE);
      apps = mode;
    } else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { command, pr, name, apps, dryRun };
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

async function main(argv: string[]): Promise<void> {
  const { command, dryRun, name } = parseArgs(argv);
  const pr = parseArgs(argv).pr || process.env.PREVIEW_PR_NUMBER;
  const appsMode = (process.env.PREVIEW_APPS as "all" | "none" | undefined) || parseArgs(argv).apps;
  if (command === "sweep") return sweep(dryRun);
  const branch = await resolveBranch(pr, name);
  const previewName = resolvePreviewName({ name: branch, prNumber: pr });
  console.log(
    `preview ${previewName} → ${previewUrl(previewName)} (D1 ${previewResourceName(previewName, "db")})`,
  );
  if (command === "config" || dryRun) {
    console.log(
      `wrote ${writePreviewWranglerConfig({ previewName, d1DatabaseId: "<created at deploy>" })}`,
    );
    return;
  }
  if (command === "deploy")
    return deployPreview(previewName, pr, branch, await appsToPreview(appsMode, pr));
  if (command === "e2e") return runE2e(previewName);
  if (command === "delete") return deleteAll(previewName);
  if (command === "reset") {
    await deleteAll(previewName);
    return deployPreview(previewName, pr, branch, await appsToPreview(appsMode, pr));
  }
}

if (process.argv[1]?.endsWith("preview.ts")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describe(error));
    process.exit(1);
  });
}
