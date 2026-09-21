// scripts/preview.ts — ONE PREVIEW PER PULL REQUEST of the one worker, on Cloudflare Worker Previews.
//
// Cribbed from cloudflare/cloudflare-os (`scripts/preview/preview.ts` + `staging-config.ts` there):
// their eighteen workers in three tiers collapse to one here, everything else keeps their shape —
// the preview name, the pkg.pr.new wrangler, the secrets path, the nightly sweep, the tolerated
// not-found on delete.
//
//   pnpm preview config  --pr <n> [--name <ref>]   write wrangler.preview.jsonc only
//   pnpm preview deploy  --pr <n>                  build, ensure the D1, upload secrets, `wrangler
//                                                  preview`, then write the PR body's preview section
//   pnpm preview e2e     --pr <n>                  the e2e suite (pnpm e2e) against the live preview
//   pnpm preview reset   --pr <n>                  delete, then deploy from scratch — THE answer to
//                                                  "something is wrong with my preview"
//   pnpm preview delete  --pr <n>                  tear it down: the preview, then its D1
//   pnpm preview sweep                             delete every preview whose PR is closed or missing,
//                                                  or that is older than 7 days
//   ... --dry-run                                  print the plan, touch no network
//
// A Worker Preview is a branch of a BASELINE worker (generate-wrangler-config.ts PREVIEW_BASELINE:
// os-next-preview-2 on the dev/preview account; nothing reads its data), named `pr<n>-<branch slug>`
// like cloudflare-os names theirs: the number keeps two branches that slugify alike apart and is how
// the sweep maps a live preview back to its pull request. One preview per PR, redeployed in place on
// every push; a preview's Durable Object namespaces, KV, R2, D1 and Artifacts namespace are its own
// (proven 2026-09-21: `preview delete` takes the namespaces and the auto-provisioned KV/R2 with it).
//
// Environment (the Depot workflow .depot/workflows/preview-os-next.yml supplies it through Doppler
// project `project-worker`, config `preview_2` — the baseline's):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   the baseline's account
//   APP_CONFIG_SESSION_SECRET, APP_CONFIG_ADMIN_API_SECRET, APP_CONFIG_SECRETS_KEY
//                                                 uploaded to the worker's Previews settings, which
//                                                 every preview inherits (`preview secret bulk`)
//   PREVIEW_NAME, PREVIEW_PR_NUMBER               the branch and the PR (flags override)
//   GITHUB_TOKEN, GITHUB_REPOSITORY               the PR body update and the sweep's PR lookups
//   PREVIEW_WRANGLER                              a wrangler binary to use instead of the pinned one
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { build } from "./build.ts";
import {
  PREVIEW_BASELINE,
  PREVIEW_CONFIG_NAME,
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

type Command = "config" | "deploy" | "e2e" | "reset" | "delete" | "sweep";
const COMMANDS: Command[] = ["config", "deploy", "e2e", "reset", "delete", "sweep"];
const USAGE = `Usage: preview.ts <${COMMANDS.join("|")}> [--pr <n>] [--name <ref>] [--dry-run]`;

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
}): string {
  const dispatch = (action: string) =>
    `depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os-next.yml --ref ${input.branch} --input pull-request-number=${input.prNumber} --input action=${action}`;
  const local = (command: string) =>
    `doppler run --project project-worker --config preview_2 -- pnpm preview ${command} --pr ${input.prNumber} --name ${input.branch}`;
  return [
    `### os-next preview: \`${input.previewName}\``,
    "",
    `**${input.url}** · deployment \`${input.deploymentId.slice(0, 8)}\` · [Cloudflare dashboard](${input.dashboardUrl}) · deleted when this PR closes`,
    "",
    "<details><summary>Preview operations (the cloudflare-os recipe)</summary>",
    "",
    "Every push redeploys the preview in place; its data carries over. When anything about it is wrong, reset it.",
    "",
    "| From CI | |",
    "| --- | --- |",
    `| Reset — destroy and redeploy from scratch | \`${dispatch("reset")}\` |`,
    `| Re-run the e2e suite against the live preview | \`${dispatch("e2e")}\` |`,
    `| Redeploy without a push | \`${dispatch("deploy")}\` |`,
    `| Delete | \`${dispatch("delete")}\` |`,
    "",
    "| From a laptop (needs Doppler; run in `apps/os-next`) | |",
    "| --- | --- |",
    `| Reset | \`${local("reset")}\` |`,
    `| e2e | \`${local("e2e")}\` |`,
    `| Deploy | \`${local("deploy")}\` |`,
    `| Delete | \`${local("delete")}\` |`,
    "",
    "The suite runs with `PROJECT_HOSTNAME_BASE` blank: previews live on workers.dev and have no project hosts, so the project-host rows skip.",
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

function runAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  console.log(`running: ${command} ${args.join(" ")}`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function capture(command: string, args: string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
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
    ready: runAsync("pnpm", ["--config.blockExoticSubdeps=false", "--dir", installDir, "install"]),
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
  return payload.result as T;
}

const account = () => {
  const id = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  if (id !== PREVIEW_BASELINE.cloudflareAccountId) {
    throw new Error(
      `CLOUDFLARE_ACCOUNT_ID ${id} is not the baseline's account ${PREVIEW_BASELINE.cloudflareAccountId} (Doppler project-worker/preview_2)`,
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
  return (await response.json()) as T;
}

const repository = () => requireEnv("GITHUB_REPOSITORY");

// ── the D1 (not auto-provisioned: created here, deleted here) ──────────────────────────────────

type D1Row = { uuid: string; name: string };

async function findDatabase(name: string): Promise<D1Row | undefined> {
  const rows = await cf<D1Row[]>(`/accounts/${account()}/d1/database?per_page=100&name=${name}`);
  return rows.find((row) => row.name === name);
}

/** Create if missing, then apply src/control-plane.sql — the same idempotent DDL every deploy of
 *  every environment runs (scripts/deploy.ts). A schema change that DDL cannot express on a
 *  populated database is what `preview reset` is for. */
async function ensureDatabase(name: string): Promise<string> {
  const existing = await findDatabase(name);
  const row =
    existing ||
    (await cf<D1Row>(`/accounts/${account()}/d1/database`, { method: "POST", body: { name } }));
  console.log(`${existing ? "found" : "created"} D1 ${name} (${row.uuid})`);
  const sql = readFileSync(path.join(ROOT, "src/control-plane.sql"), "utf8");
  await cf(`/accounts/${account()}/d1/database/${row.uuid}/query`, {
    method: "POST",
    body: { sql },
  });
  return row.uuid;
}

async function deleteDatabase(name: string): Promise<void> {
  const row = await findDatabase(name);
  if (!row) return console.warn(`D1 ${name} did not exist; continuing.`);
  await cf(`/accounts/${account()}/d1/database/${row.uuid}`, { method: "DELETE" });
  console.log(`deleted D1 ${name}`);
}

// ── the preview itself ─────────────────────────────────────────────────────────────────────────

/** `preview secret bulk` writes the WORKER's Previews settings, which every preview of it inherits:
 *  one upload covers every preview, and each run refreshes them. The values go through a 0700 tmp
 *  file, never argv (visible in `ps`) and never the config (wrangler prints config values). */
async function uploadPreviewSecrets(wrangler: string): Promise<void> {
  const secrets = Object.fromEntries(
    ["APP_CONFIG_SESSION_SECRET", "APP_CONFIG_ADMIN_API_SECRET", "APP_CONFIG_SECRETS_KEY"].map(
      (name) => [name, requireEnv(name)],
    ),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "os-next-preview-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const result = await capture(wrangler, [
      "preview",
      "secret",
      "bulk",
      file,
      "-c",
      PREVIEW_CONFIG_NAME,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `wrangler preview secret bulk failed with exit code ${result.status}\n${result.stderr}`,
      );
    }
    console.log(
      `uploaded ${Object.keys(secrets).length} secrets to the Previews settings of ${PREVIEW_BASELINE.workerName}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The deploy stamp a smoke waits for (src/worker.ts `/version`): the new deployment's id, on the
 *  preview's URL. Propagation was observed at a few seconds; 90 s is the budget deploy-helpers uses. */
async function waitForDeployment(url: string, deploymentId: string): Promise<void> {
  for (let attempt = 1; attempt <= 18; attempt++) {
    const text = await fetch(`${url}/version`)
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    if (text.startsWith(deploymentId)) return console.log(`${url}/version answers ${text.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${url}/version never answered deployment ${deploymentId}`);
}

async function deployPreview(previewName: string, prNumber: string | undefined, branch: string) {
  await build();
  const databaseId = await ensureDatabase(previewResourceName(previewName, "db"));
  writePreviewWranglerConfig({ previewName, d1DatabaseId: databaseId });
  const wrangler = preparePreviewWrangler();
  try {
    await wrangler.ready;
    await uploadPreviewSecrets(wrangler.command);
    console.log(`running: wrangler preview --name ${previewName} -c ${PREVIEW_CONFIG_NAME} --json`);
    const result = await capture(wrangler.command, [
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
        ? ` — the baseline ${PREVIEW_BASELINE.workerName} is missing; deploy it first: pnpm deploy --env preview_2`
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
    await waitForDeployment(url, deploymentId);
    const slug = data.preview?.slug || previewName;
    const summary = {
      previewName,
      url,
      deploymentId,
      slug,
      dashboardUrl: `https://dash.cloudflare.com/${PREVIEW_BASELINE.cloudflareAccountId}/workers/services/view/${PREVIEW_BASELINE.workerName}/production/previews/${slug}`,
    };
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(path.join(OUTPUT_DIR, "preview.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\npreview ${previewName}: ${url}`);
    if (prNumber && process.env.GITHUB_TOKEN) {
      const section = renderPullRequestSection({ ...summary, prNumber, branch });
      const pull = await github<{ body: string | null }>(
        `/repos/${repository()}/pulls/${prNumber}`,
      );
      await github(`/repos/${repository()}/pulls/${prNumber}`, {
        method: "PATCH",
        body: { body: splicePullRequestBody(pull.body || "", section) },
      });
      console.log(`wrote the preview section into the body of PR #${prNumber}`);
    }
  } finally {
    wrangler.cleanup();
  }
}

/** Deleting a preview that was never created — a PR closed before its first deploy, a re-run of
 *  the cleanup job, the sweep racing the close job — is the expected case, not a failure. */
async function deletePreview(previewName: string, wranglerCommand?: string): Promise<void> {
  writePreviewWranglerConfig({ previewName, d1DatabaseId: "00000000-0000-0000-0000-000000000000" });
  const wrangler = wranglerCommand
    ? { command: wranglerCommand, ready: Promise.resolve(), cleanup: () => {} }
    : preparePreviewWrangler();
  try {
    await wrangler.ready;
    console.log(
      `running: wrangler preview delete --name ${previewName} -c ${PREVIEW_CONFIG_NAME} -y`,
    );
    const result = await capture(wrangler.command, [
      "preview",
      "delete",
      "--name",
      previewName,
      "-c",
      PREVIEW_CONFIG_NAME,
      "-y",
    ]);
    if (result.status !== 0) {
      if (
        /not found|does not exist|10007|10025|10222/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        console.warn(`preview ${previewName} did not exist; continuing.`);
      } else {
        throw new Error(
          `wrangler preview delete failed with exit code ${result.status}\n${result.stderr}`,
        );
      }
    } else {
      console.log(`deleted preview ${previewName}`);
    }
  } finally {
    wrangler.cleanup();
  }
  await deleteDatabase(previewResourceName(previewName, "db"));
}

/** `pnpm e2e` in deployed-target mode (e2e/support/global-setup.ts): the same suite prd's deploy
 *  runs after every merge, pointed at the preview. No project hosts on workers.dev, so the base is
 *  blank and the project-host rows skip. */
async function runE2e(previewName: string): Promise<void> {
  const url = previewUrl(previewName);
  await runAsync("pnpm", ["e2e", "--no-file-parallelism"], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKER_BASE_URL: url,
      ADMIN_API_SECRET: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
      PROJECT_HOSTNAME_BASE: "",
      MCP_BASE_URL: `${url}/mcp`,
    },
  });
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
    `/accounts/${account()}/workers/workers/${PREVIEW_BASELINE.workerName}/previews`,
  );
  console.log(`${previews.length} preview(s) on ${PREVIEW_BASELINE.workerName}`);
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
  const orphanDatabases = (
    await cf<D1Row[]>(
      `/accounts/${account()}/d1/database?per_page=100&name=${PREVIEW_BASELINE.workerName}-pr`,
    )
  ).filter(
    (row) =>
      /-db$/.test(row.name) &&
      row.name.startsWith(`${PREVIEW_BASELINE.workerName}-pr`) &&
      !live.has(row.name),
  );
  for (const { name, reasons } of stale) console.log(`  delete ${name}: ${reasons.join("; ")}`);
  for (const row of orphanDatabases) console.log(`  delete orphan D1 ${row.name}`);
  if (dryRun || (stale.length === 0 && orphanDatabases.length === 0)) return;
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
    if (failures.length > 0) throw new Error(`sweep failures:\n  ${failures.join("\n  ")}`);
  } finally {
    wrangler.cleanup();
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  let pr: string | undefined;
  let name: string | undefined;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--pr") pr = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { command, pr, name, dryRun };
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
  if (command === "deploy") return deployPreview(previewName, pr, branch);
  if (command === "e2e") return runE2e(previewName);
  if (command === "delete") return deletePreview(previewName);
  if (command === "reset") {
    await deletePreview(previewName);
    return deployPreview(previewName, pr, branch);
  }
}

if (process.argv[1]?.endsWith("preview.ts")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(describe(error));
    process.exit(1);
  });
}
