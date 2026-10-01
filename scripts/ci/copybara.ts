// THE ONE-WAY PUBLIC COPIES: core/ to iterate/core, and packages/ and configs/ to iterate/packages
// (copybara/copy.bara.sky, tasks/complete/2026-10-01-core-public-copy.md).
//
//   node scripts/ci/copybara.ts sync --sha <deployed sha>
//   node scripts/ci/copybara.ts check --sha <commit>
//   node scripts/ci/copybara.ts workspace-files [--check]
//
// `sync` (Deploy OS, after a production deploy) copies iterate/iterate's commits up to the deployed
// one into each copy's main, then checks each copy holds exactly that commit's files, and that a
// fresh clone of iterate/core passes the self-host recipe. An empty copy (its first run) starts as
// one snapshot of that commit. It pushes as the iterate GitHub App, with a token that can only write
// the two copies.
//
// `check` (a pull request's check, .depot/workflows/copybara.yml) writes what iterate/core would hold
// at a commit into a folder, pushing nothing, and runs the self-host recipe against it.
//
// `workspace-files` writes iterate/core's pnpm-workspace.yaml and pnpm-lock.yaml (copybara/core/).
//
// Copybara runs on $JAVA_HOME's Java, 25 or newer (its jar's class files are version 69).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { createCli } from "trpc-cli";
import { parse as parseYaml, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import { iterateAppFromPrd, iterateAppToken } from "./iterate-app-token.ts";

const COPYBARA = {
  version: "v20260928",
  sha256: "25807645ee17b7b863f4f885012b06192b9952632b540bdf8a21088313fe4925",
};
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CONFIG = join(REPO_ROOT, "copybara/copy.bara.sky");
/** copy.bara.sky's workflows, each named after the iterate/<repo> it pushes to. */
const COPIES = ["core", "packages"];
const urlOf = (copy: string) => `https://github.com/iterate/${copy}`;
// The App's bot user (`gh api 'users/iterate[bot]'`), so its commits link to it.
const COMMITTER = {
  name: "iterate[bot]",
  email: "233973017+iterate[bot]@users.noreply.github.com",
};

/** Copies the commits up to `sha` into each copy, checks each is `sha`'s, and that iterate/core
 *  builds from a fresh clone. */
export async function sync(options: {
  /** The deployed commit to copy up to. */
  sha: string;
}) {
  const app = await iterateAppToken({
    ...(await iterateAppFromPrd()),
    owner: "iterate",
    repositories: COPIES,
    permissions: { contents: "write" },
  });
  console.log(
    `[copybara] iterate app token for ${app.repositories.join(", ")}: ${JSON.stringify(app.permissions)}`,
  );
  const work = mkdtempSync(join(tmpdir(), "copybara-"));
  try {
    // git's credential store, which Copybara hands to every git command it runs
    const credentials = join(work, "git-credentials");
    writeFileSync(credentials, `https://x-access-token:${app.token}@github.com\n`, { mode: 0o600 });
    const withToken = ["-c", `credential.helper=store --file=${credentials}`];
    for (const copy of COPIES) {
      // An empty copy starts as this commit's snapshot: its history begins after its parent.
      const empty = !(await output("git", [
        ...withToken,
        "ls-remote",
        "--heads",
        urlOf(copy),
        "main",
      ]));
      const migrate = await copybara(copy, [
        options.sha,
        ...(empty ? ["--force", "--last-rev", await parentOf(options.sha)] : []),
        "--git-credential-helper-store-file",
        credentials,
        "--nogit-prompt",
        "--git-committer-name",
        COMMITTER.name,
        "--git-committer-email",
        COMMITTER.email,
      ]);
      process.stdout.write(migrate.stderr);
      if (migrate.status === 4)
        console.log(`[copybara] ${copy}: nothing new to copy up to ${options.sha}`);
      else if (migrate.status !== 0)
        throw new Error(`Copybara's ${copy} exited with ${migrate.status}`);

      const expected = join(work, `${copy}-expected`);
      await writeToFolder(copy, options.sha, expected);
      await checkCopy({ copy, sha: options.sha, expected, withToken, work });
    }

    const clone = join(work, "clone");
    await run("git", [...withToken, "clone", "--quiet", "--depth", "1", urlOf("core"), clone]);
    await checkSelfHost(clone);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What iterate/core would hold at `sha`, written to a folder and run through the self-host
 *  recipe, pushing nothing: a pull request's check that the copy still installs and builds. */
export async function check(options: {
  /** The commit to copy, which must be on GitHub (Copybara fetches it). */
  sha: string;
}) {
  const work = mkdtempSync(join(tmpdir(), "copybara-check-"));
  try {
    const folder = join(work, "core");
    await writeToFolder("core", options.sha, folder);
    // the folder as a fresh clone has it: every file committed, so the recipe's `git status` check
    // means what it does there
    const commit = ["-c", "user.name=copybara", "-c", "user.email=copybara@localhost"];
    for (const args of [
      ["init", "--quiet"],
      ["add", "--all"],
      [...commit, "commit", "--quiet", "-m", "copy"],
    ])
      await run("git", args, { cwd: folder });
    await checkSelfHost(folder);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Copybara's `migrate` of a copy's workflow with `args`: its exit status (4: nothing to migrate)
 *  and what it printed. */
async function copybara(copy: string, args: string[]) {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) throw new Error("JAVA_HOME is unset: Copybara needs Java 25 or newer");
  const jar = await copybaraJar();
  return new Promise<{ status: number | null; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(join(javaHome, "bin", "java"), [
      "-jar",
      jar,
      "migrate",
      CONFIG,
      copy,
      ...args,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (status) => resolvePromise({ status, stderr }));
  });
}

/** What a copy holds at `sha`, as Copybara writes it: the same file selection and
 *  transformations as a migration. */
async function writeToFolder(copy: string, sha: string, folder: string) {
  const written = await copybara(copy, [sha, "--to-folder", "--folder-dir", folder, "--squash"]);
  if (written.status === 0) return;
  process.stdout.write(written.stderr);
  throw new Error(`Copybara's ${copy} --to-folder exited with ${written.status}`);
}

/** `command args`, its output streamed to ours (an install, a build), throwing unless it exits 0. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  console.log(`[copybara] ${[command, ...args].join(" ")}`);
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
    });
    child.once("error", reject);
    child.once("close", (status) =>
      status === 0
        ? resolvePromise()
        : reject(new Error(`${command} ${args[0]} exited with ${status}`)),
    );
  });
}

/** `command args`'s output, trimmed. */
async function output(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const { stdout } = await promisify(execFile)(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/** `sha`'s first parent, from this checkout (a CI checkout is one commit deep: fetched if need be). */
async function parentOf(sha: string) {
  await run("git", ["fetch", "--quiet", "--depth=2", "origin", sha], { cwd: REPO_ROOT });
  return output("git", ["rev-parse", `${sha}^`], { cwd: REPO_ROOT });
}

/**
 * The self-host recipe (core/os/public/setup-prompt.md) against a checkout of iterate/core, as far
 * as it goes without a Cloudflare account: the install (with --frozen-lockfile, which proves the
 * copy's lockfile), the self-host build, a dry-run deploy, and the SDK imports its later steps run.
 * After all that, `git status` in the checkout must be clean.
 */
async function checkSelfHost(checkout: string) {
  await run("pnpm", ["install", "--frozen-lockfile"], { cwd: checkout });
  await run("pnpm", ["--filter", "os", "build"], {
    cwd: checkout,
    env: { CLOUDFLARE_ENV: "self-host" },
  });
  const os = join(checkout, "core/os");
  await run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", "dist/server/wrangler.json", "--dry-run"],
    { cwd: os },
  );
  await run("node", ["--eval", 'Promise.all([import("iterate/node"), import("capnweb")])'], {
    cwd: os,
  });
  // and leaves the checkout clean: everything it made is ignored, and nothing tracked changed
  const status = await output("git", ["status", "--porcelain"], { cwd: checkout });
  if (status)
    throw new Error(
      `the recipe left iterate/core's checkout dirty (copybara/core/.gitignore, or an install that rewrites a tracked file):\n${status.split("\n").slice(0, 20).join("\n")}`,
    );
  console.log(`[copybara] core: it installs, builds and deploys (dry run), and stays clean`);
}

/**
 * A copy is in sync when its head's tree hash equals the hash of the folder Copybara wrote for
 * `sha`. A git tree hash is a hash of the content alone, so equal hashes mean every file is the
 * same, and a file added by hand shows up too. Only the copy's head commit and its trees are
 * fetched, and its `GitOrigin-RevId` trailer must name the iterate/iterate commit it came from.
 */
async function checkCopy(input: {
  copy: string;
  sha: string;
  expected: string;
  withToken: string[];
  work: string;
}) {
  const url = urlOf(input.copy);
  const gitDir = join(input.work, `${input.copy}.git`);
  const git = (...args: string[]) =>
    output("git", ["--git-dir", gitDir, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: join(input.work, `${input.copy}.index`) },
    });
  await run("git", ["init", "--quiet", "--bare", gitDir]);
  await git(
    ...input.withToken,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "--filter=blob:none",
    url,
    "main",
  );
  const copiedCommit = await git(
    "log",
    "-1",
    "--format=%(trailers:key=GitOrigin-RevId,valueonly)",
    "FETCH_HEAD",
  );
  if (!/^[0-9a-f]{40}$/.test(copiedCommit))
    throw new Error(`${url}'s main names no GitOrigin-RevId: ${JSON.stringify(copiedCommit)}`);
  const head = await git("rev-parse", "FETCH_HEAD");
  const tree = await git("rev-parse", "FETCH_HEAD^{tree}");
  await git("--work-tree", input.expected, "add", "--all", ".");
  const expectedTree = await git("write-tree");
  if (tree !== expectedTree)
    throw new Error(
      `${url}/commit/${head} is not what ${input.sha} should copy: ${await git("diff-tree", "-r", "--name-status", expectedTree, tree)}`,
    );
  console.log(`[copybara] in sync: ${url}/commit/${head} is ${input.sha}'s (tree ${tree})`);
}

/** The pinned Copybara release's jar, downloaded once per machine and checked against its SHA-256. */
async function copybaraJar() {
  const dir = join(tmpdir(), "copybara-jar");
  const jar = join(dir, `copybara-${COPYBARA.version}.jar`);
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (existsSync(jar) && hash(jar) === COPYBARA.sha256) return jar;
  mkdirSync(dir, { recursive: true });
  await run("curl", [
    "-fsSL",
    "--retry",
    "3",
    "-o",
    jar,
    `https://github.com/google/copybara/releases/download/${COPYBARA.version}/copybara_deploy.jar`,
  ]);
  if (hash(jar) !== COPYBARA.sha256)
    throw new Error(`the Copybara ${COPYBARA.version} jar's SHA-256 is not ${COPYBARA.sha256}`);
  return jar;
}

/** iterate/core's workspace packages. */
const CORE_PACKAGES = ["core/os", "core/lib"];
const CORE_WORKSPACE_HEADER =
  "# iterate/core's workspace: generated in iterate's own repo from its pnpm-workspace.yaml, for\n" +
  "# these packages alone, with the same settings and the catalog trimmed to what they use.\n";

/**
 * Generates iterate/core's pnpm-workspace.yaml and pnpm-lock.yaml into copybara/core/: this repo's two,
 * cut down to core/os and core/lib. With `check`, fails if the committed ones are out of date.
 *
 * How: pnpm makes them in a scratch folder (`pnpm install --lockfile-only` with only the copy's
 * packages listed drops every other package, and the catalog entries nothing uses), then
 * checkSubset proves the copy resolves nothing this repo doesn't.
 */
export async function workspaceFiles(options: {
  /** Fail when copybara/core/'s files are out of date, instead of writing them. */
  check?: boolean;
}) {
  const out = join(REPO_ROOT, "copybara/core");
  const scratch = mkdtempSync(join(tmpdir(), "copybara-workspace-"));
  try {
    cpSync(join(out, "package.json"), join(scratch, "package.json"));
    cpSync(join(REPO_ROOT, "pnpm-lock.yaml"), join(scratch, "pnpm-lock.yaml"));
    cpSync(join(REPO_ROOT, "patches"), join(scratch, "patches"), { recursive: true });
    for (const pkg of CORE_PACKAGES) {
      mkdirSync(join(scratch, pkg), { recursive: true });
      cpSync(join(REPO_ROOT, pkg, "package.json"), join(scratch, pkg, "package.json"));
    }
    const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const packagesList = /^packages:\n(?: {2}- .*\n)+/mu;
    if (!packagesList.test(workspace))
      throw new Error("pnpm-workspace.yaml has no `packages:` list of `  - <path>` lines");
    writeFileSync(
      join(scratch, "pnpm-workspace.yaml"),
      workspace.replace(
        packagesList,
        `packages:\n${CORE_PACKAGES.map((p) => `  - ${p}\n`).join("")}`,
      ),
    );
    // With an empty metadata cache of its own, pnpm reads each package's manifest from the registry,
    // where a published version never changes, so every machine writes the same lockfile. A
    // machine's own cache can hold another peer range for the same version than CI's.
    const lockfileOnly = (extra: string[]) =>
      run(
        "pnpm",
        [
          "install",
          "--lockfile-only",
          "--ignore-scripts",
          `--config.cache-dir=${join(scratch, ".pnpm-cache")}`,
          ...extra,
        ],
        { cwd: scratch },
      );
    // pnpm refuses a patch for a package nothing installs, and an override naming a catalog entry
    // the catalog no longer has (`cleanupUnusedCatalogs` drops what the copy doesn't use), and this
    // repo patches and overrides packages the copy may not use (@cloudflare/vitest-plugin, once only
    // test/ used it; @codemirror/state, once only packages/ui): resolve once allowing them, then keep
    // the patches and overrides whose package the copy's lockfile resolves.
    await lockfileOnly(["--config.allow-unused-patches=true"]);
    const resolved = readFileSync(join(scratch, "pnpm-lock.yaml"), "utf8");
    const scratchWorkspace = join(scratch, "pnpm-workspace.yaml");
    const document = parseDocument(readFileSync(scratchWorkspace, "utf8"));
    for (const [section, after] of [
      ["patchedDependencies", "("],
      ["overrides", "@"],
    ] as const) {
      const entries = document.get(section);
      if (!(entries instanceof YAMLMap)) continue;
      // a patch's key is `name@version`, which the lockfile resolves as `name@version(patch_hash=…)`;
      // an override's is the package's name, resolved as `name@version`
      for (const key of entries.items.map((item) => String(item.key)))
        if (!resolved.includes(`\n  ${key}${after}`) && !resolved.includes(`\n  '${key}${after}`))
          entries.delete(key);
    }
    writeFileSync(scratchWorkspace, document.toString());
    cpSync(join(REPO_ROOT, "pnpm-lock.yaml"), join(scratch, "pnpm-lock.yaml"));
    await lockfileOnly([]);
    const files = {
      "pnpm-workspace.yaml":
        CORE_WORKSPACE_HEADER + readFileSync(join(scratch, "pnpm-workspace.yaml"), "utf8"),
      "pnpm-lock.yaml": readFileSync(join(scratch, "pnpm-lock.yaml"), "utf8"),
    };
    checkSubset(files);

    const stale = Object.entries(files).filter(
      ([name, content]) =>
        !existsSync(join(out, name)) || readFileSync(join(out, name), "utf8") !== content,
    );
    if (options.check && stale.length > 0) {
      // what changed, as a diff of the committed file against the one generated here
      for (const [name, content] of stale) {
        writeFileSync(join(scratch, `generated-${name}`), content);
        await run("git", [
          "--no-pager",
          "diff",
          "--no-index",
          "--stat",
          join(out, name),
          join(scratch, `generated-${name}`),
        ]).catch(() => {});
      }
      throw new Error(
        `copybara/core/{${stale.map(([name]) => name).join(",")}} are out of date: run \`node scripts/ci/copybara.ts workspace-files\` and commit them`,
      );
    }
    for (const [name, content] of stale) writeFileSync(join(out, name), content);
    console.log(
      `[copybara] copybara/core/: ${stale.length === 0 ? "current" : `wrote ${stale.map(([name]) => name).join(", ")}`}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const Dependency = z.object({ specifier: z.string(), version: z.string() });

/** The parts of a pnpm lockfile `checkSubset` compares. */
const Lockfile = z.object({
  importers: z.record(z.string(), z.record(z.string(), z.record(z.string(), Dependency))),
  packages: z.record(z.string(), z.object({ resolution: z.unknown() })).optional(),
  catalogs: z.object({ default: z.record(z.string(), Dependency).optional() }).optional(),
});

const RootManifest = z.object({
  packageManager: z.string(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * The copy resolves nothing this repo doesn't: every package it locks is locked here at the same
 * version with the same integrity, each copied package asks for the same specifiers and gets the
 * same versions, and its root asks for the versions ours does. Peer contexts and `optional` flags
 * may differ, and do: with the other packages gone, a peer they brought in is missing (trpc-cli is
 * locked without the `effect` another package brings) and a package only an optional dependency
 * reaches is marked optional.
 */
function checkSubset(files: { "pnpm-workspace.yaml": string; "pnpm-lock.yaml": string }) {
  const lock = (text: string) => Lockfile.parse(parseYaml(text));
  // `1.168.58(crossws@0.4.4)(…)` → `1.168.58`: a version without the peers pnpm resolved it with
  const withoutPeers = (dependency: z.infer<typeof Dependency> | undefined) =>
    dependency && { specifier: dependency.specifier, version: dependency.version.split("(")[0] };
  const ours = lock(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));
  const theirs = lock(files["pnpm-lock.yaml"]);
  const problems = [
    ...Object.entries(theirs.packages || {})
      .filter(
        ([key, entry]) => !isDeepStrictEqual(ours.packages?.[key]?.resolution, entry.resolution),
      )
      .map(([key]) => `${key} is not locked here with the same integrity`),
    ...CORE_PACKAGES.flatMap((pkg) =>
      Object.entries(theirs.importers[pkg] || {}).flatMap(([kind, dependencies]) =>
        Object.entries(dependencies)
          .filter(
            ([name, dependency]) =>
              !isDeepStrictEqual(
                withoutPeers(ours.importers[pkg]?.[kind]?.[name]),
                withoutPeers(dependency),
              ),
          )
          .map(([name]) => `${pkg} ${kind} ${name} is not what this repo locks`),
      ),
    ),
    ...Object.entries(theirs.catalogs?.default || {})
      .filter(
        ([name, entry]) =>
          !isDeepStrictEqual(withoutPeers(ours.catalogs?.default?.[name]), withoutPeers(entry)),
      )
      .map(([name]) => `catalog ${name} is not what this repo locks`),
  ];
  const rootManifest = (path: string) => RootManifest.parse(JSON.parse(readFileSync(path, "utf8")));
  const ourRoot = rootManifest(join(REPO_ROOT, "package.json"));
  const theirRoot = rootManifest(join(REPO_ROOT, "copybara/core/package.json"));
  if (theirRoot.packageManager !== ourRoot.packageManager)
    problems.push(`packageManager ${theirRoot.packageManager} is not ${ourRoot.packageManager}`);
  for (const [name, spec] of Object.entries(theirRoot.devDependencies || {}))
    if (ourRoot.devDependencies?.[name] !== spec)
      problems.push(
        `copybara/core/package.json asks for ${name}@${spec}, this repo for ${ourRoot.devDependencies?.[name]}`,
      );
  if (problems.length > 0)
    throw new Error(
      `iterate/core's dependencies must be a subset of this repo's:\n${problems.join("\n")}`,
    );
}

void createCli(import.meta).run();
