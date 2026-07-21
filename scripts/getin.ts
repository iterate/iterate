import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readDevServerInfo } from "../apps/os/scripts/lib/dev-server-info.ts";

// `pnpm getin` — one command into local OS, no recipe to remember.
//
// Automates the minting recipe from docs/dev-environments.md ("Acting as
// users and admins"): make sure the worktree's dev server is running, get or
// create a project for the test identity via the itx operator path, mint a
// forged session with org+project claims, and open the one-shot browser
// sign-in URL.
//
// Runs as a trpc-cli module CLI (`trpc-cli scripts/getin.ts` from the root
// `getin` script) — the default export is the only command.
//
//   pnpm getin                 # open local OS signed in as test+test@nustom.com
//   pnpm getin --print         # print the sign-in URL instead of opening it
//   pnpm getin -w              # pick a worktree (most recently touched first)
//   pnpm getin -w getin        # run in the named worktree
//
// Doppler-wrapped subcommands run from apps/os so the project resolves to
// `os` and the config to whatever `doppler setup` chose for this worktree
// (dev, dev_<you>, ...). Local dev only — for previews/prod use the manual
// `auth:mint` recipe.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_ROOT = join(REPO_ROOT, "apps/os");

export type GetinOptions = {
  /** identity email to mint (default test+test@nustom.com)
   * @alias e
   */
  email?: string;
  /** project slug to get or create (default test), or a prj_ id that must already exist
   * @alias p
   */
  project?: string;
  /** doppler config override (default: this worktree's `doppler setup` choice) */
  config?: string;
  /** print the one-shot sign-in URL instead of opening the browser */
  print?: boolean;
  /** run in another worktree — pass a directory name, branch, or path; bare -w picks interactively, most recently touched first
   * @alias w
   */
  worktree?: boolean | string;
};

/** get into local OS: ensure the dev server, get-or-create the test project, mint a session, open the browser */
export default async function getin(options?: GetinOptions) {
  const email = options?.email || "test+test@nustom.com";
  const projectRef = options?.project || "test";
  const config = options?.config;

  if (options?.worktree !== undefined && options.worktree !== false) {
    const ref = typeof options.worktree === "string" ? options.worktree : undefined;
    return runInWorktree(ref, [
      ...(options.email ? ["--email", options.email] : []),
      ...(options.project ? ["--project", options.project] : []),
      ...(config ? ["--config", config] : []),
      ...(options.print ? ["--print"] : []),
    ]);
  }

  const devServer = ensureDevServer(config);
  console.log(`dev server: ${devServer.baseUrl} (pid ${devServer.pid})`);

  const project = getOrCreateProject(devServer.baseUrl, projectRef, config);
  console.log(`project: ${project.slug} (${project.id})`);

  // OS authorizes from claims, so when the project has no auth-side org (the
  // operator/admin lane leaves organizationId null) a synthetic org is enough
  // — see docs/dev-environments.md.
  const org = project.organizationId
    ? {
        id: project.organizationId,
        slug: project.organizationSlug || "org",
        name: project.organizationName || "Org",
        role: "admin",
      }
    : { id: "org_getin", slug: "getin", name: "Getin", role: "admin" };

  const url = mintBrowserUrl({ baseUrl: devServer.baseUrl, email, org, project, config });

  if (options?.print) {
    console.log(url);
    return;
  }
  console.log(`opening ${devServer.baseUrl} as ${email} ...`);
  spawnSync("open", [url]);
}

// ---------------------------------------------------------------------------

async function runInWorktree(ref: string | undefined, passthroughArgs: string[]) {
  const worktrees = listWorktrees();
  let target = ref
    ? worktrees.find((w) => basename(w.path) === ref || w.branch === ref || w.path === ref)
    : undefined;
  if (ref && !target) {
    console.error(`No worktree matching "${ref}". Known worktrees:`);
    for (const w of worktrees) console.error(`  ${basename(w.path)} (${w.branch ?? "detached"})`);
    process.exit(1);
  }
  target = target ?? (await promptForWorktree(worktrees));
  console.log(`running pnpm getin in ${target.path} ...`);
  const result = spawnSync("pnpm", ["getin", ...passthroughArgs], {
    cwd: target.path,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function listWorktrees() {
  const out = run("git", ["worktree", "list", "--porcelain"], REPO_ROOT);
  const worktrees: { path: string; branch: string | undefined; touchedAt: number }[] = [];
  for (const block of out.split("\n\n").filter(Boolean)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    worktrees.push({ path, branch, touchedAt: touchedAt(path) });
  }
  return worktrees.sort((a, b) => b.touchedAt - a.touchedAt);
}

/** "Most recently touched": newest of HEAD commit time and worktree-root mtime. */
function touchedAt(worktreePath: string) {
  let commitMs = 0;
  try {
    const seconds = run("git", ["-C", worktreePath, "log", "-1", "--format=%ct"], REPO_ROOT);
    commitMs = Number(seconds) * 1000;
  } catch {
    // brand-new worktree with no commits, or path gone — fall back to mtime
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(worktreePath).mtimeMs;
  } catch {
    // stale worktree entry whose directory was deleted
  }
  return Math.max(commitMs, mtimeMs);
}

async function promptForWorktree(worktrees: ReturnType<typeof listWorktrees>) {
  worktrees.forEach((w, i) => {
    const label = `${basename(w.path)} (${w.branch ?? "detached"}, touched ${ago(w.touchedAt)})`;
    console.log(`${i + 1}. ${label}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`worktree [1-${worktrees.length}] (default 1): `);
  rl.close();
  const index = answer.trim() === "" ? 0 : Number(answer.trim()) - 1;
  const target = worktrees[index];
  if (!target) {
    console.error(`Invalid selection "${answer.trim()}".`);
    process.exit(1);
  }
  return target;
}

function ago(timestampMs: number) {
  const minutes = Math.round((Date.now() - timestampMs) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function ensureDevServer(config: string | undefined) {
  const live = readDevServerInfo(APP_ROOT, { requireLive: true });
  if (live) return live;
  console.log("no live dev server — starting one detached ...");
  const result = spawnSync(
    "pnpm",
    ["dev", "start", "--detach", ...(config ? ["--config", config] : [])],
    { cwd: APP_ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) throw new Error("pnpm dev start --detach failed (see output above).");
  const started = readDevServerInfo(APP_ROOT, { requireLive: true });
  if (!started) throw new Error("Dev server started but published no discovery info.");
  return started;
}

type ProjectClaim = {
  id: string;
  slug: string;
  organizationId: string | null;
  organizationSlug: string | null;
  organizationName: string | null;
};

/** `ref` is a prj_ id (must already exist) or a slug (created when missing). */
function getOrCreateProject(
  baseUrl: string,
  ref: string,
  config: string | undefined,
): ProjectClaim {
  const script = [
    `const ref = ${JSON.stringify(ref)};`,
    `const byId = ref.startsWith("prj_");`,
    `const projects = await itx.projects.list({ scope: "deployment" });`,
    `const existing = projects.find((p) => (byId ? p.id === ref : p.slug === ref));`,
    `if (existing) return existing;`,
    `if (byId) throw new Error("No project with id " + ref + " on this deployment.");`,
    `const project = await itx.projects.get(ref).create({});`,
    `const description = await project.__describe();`,
    `return { id: description.projectId, slug: ref, organizationId: null, organizationSlug: null, organizationName: null };`,
  ].join("\n");
  const out = runViaDoppler(
    [
      "pnpm",
      "exec",
      "tsx",
      "scripts/cli.ts",
      "itx",
      "run",
      "--base-url",
      baseUrl,
      "--eval",
      script,
    ],
    config,
  );
  // itx run prints exactly one JSON document on stdout
  return JSON.parse(out.slice(out.indexOf("{"))) as ProjectClaim;
}

function mintBrowserUrl(input: {
  baseUrl: string;
  email: string;
  org: { id: string; slug: string; name: string; role: string };
  project: ProjectClaim;
  config: string | undefined;
}) {
  const out = runViaDoppler(
    [
      "pnpm",
      "exec",
      "tsx",
      join(REPO_ROOT, "scripts/auth/mint-session.ts"),
      "--email",
      input.email,
      "--orgs",
      JSON.stringify([input.org]),
      "--projects",
      JSON.stringify([
        { id: input.project.id, slug: input.project.slug, organizationId: input.org.id },
      ]),
      "--base-url",
      input.baseUrl,
      "--browser-url",
    ],
    input.config,
  );
  const url = out.trim().split("\n").at(-1)!;
  if (!url.startsWith("http")) throw new Error(`auth:mint printed no URL:\n${out}`);
  return url;
}

/**
 * Run a command under `doppler run` from apps/os, where the project resolves
 * to `os` and the config to this worktree's `doppler setup` choice — that
 * config carries the forge key, admin API secret, and auth issuer.
 */
function runViaDoppler(command: string[], config: string | undefined) {
  const dopplerArgs = ["run", ...(config ? ["--config", config] : []), "--", ...command];
  return run("doppler", dopplerArgs, APP_ROOT);
}

function run(command: string, commandArgs: string[], cwd: string) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const summary = `${command} ${commandArgs.slice(0, 4).join(" ")} ...`;
    throw new Error(`${summary} failed (exit ${result.status})`);
  }
  return result.stdout;
}
