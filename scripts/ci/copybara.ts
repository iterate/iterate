// THE ONE-WAY COPY OF core/ TO THE PUBLIC iterate/os (copybara/copy.bara.sky,
// tasks/core-public-copy.md).
//
//   node scripts/ci/copybara.ts sync --sha <deployed sha>
//   node scripts/ci/copybara.ts check --sha <commit>
//   node scripts/ci/copybara.ts root [--check]
//
// `sync` copies iterate/iterate's commits up to a deployed one into iterate/os's main, then checks
// that the copy holds exactly what it should at that commit, and that a fresh clone passes the
// self-host recipe. Deploy OS runs it after a production deploy. An empty copy (its first run)
// starts as one snapshot of that commit: its history begins after the commit's parent (Copybara's
// --force --last-rev), not with every past commit. A run with nothing new to copy is a pass
// (Copybara's exit code 4). It pushes as the iterate GitHub App, with a token that can only write
// iterate/os (./iterate-app-token.ts).
//
// `check` writes what the copy would hold at a commit into a folder, pushing nothing, and runs the
// self-host recipe against it: a pull request's check (.depot/workflows/copybara.yml).
//
// `root` writes iterate/os's own pnpm-workspace.yaml and pnpm-lock.yaml into copybara/os/, from
// this repo's, for the copy's packages alone; `--check` fails when they're stale instead.
//
// Copybara runs on $JAVA_HOME's Java, 25 or newer (its jar's class files are version 69; its
// README's "21" is out of date). A laptop runs every command the same way.
import { execFileSync, spawnSync } from "node:child_process";
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
import { isDeepStrictEqual } from "node:util";
import { createCli } from "trpc-cli";
import { parse as parseYaml, parseDocument, YAMLMap } from "yaml";
import { iterateAppFromPrd, iterateAppToken } from "./iterate-app-token.ts";

const COPYBARA = {
  version: "v20260928",
  sha256: "25807645ee17b7b863f4f885012b06192b9952632b540bdf8a21088313fe4925",
};
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CONFIG = join(REPO_ROOT, "copybara/copy.bara.sky");
/** copy.bara.sky's workflow, and the iterate/<repo> it pushes to. */
const WORKFLOW = "os";
const REPO = "os";
const COPY_URL = `https://github.com/iterate/${REPO}`;
// The App's bot user (`gh api 'users/iterate[bot]'`), so its commits link to it.
const COMMITTER = {
  name: "iterate[bot]",
  email: "233973017+iterate[bot]@users.noreply.github.com",
};

/** Copies the commits up to `sha` into iterate/os, then checks the copy is `sha`'s and builds. */
export async function sync(options: {
  /** The deployed commit to copy up to. */
  sha: string;
}) {
  const app = await iterateAppToken({
    ...(await iterateAppFromPrd()),
    owner: "iterate",
    repositories: [REPO],
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
    const pushing = [
      "--git-credential-helper-store-file",
      credentials,
      "--nogit-prompt",
      "--git-committer-name",
      COMMITTER.name,
      "--git-committer-email",
      COMMITTER.email,
    ];
    // An empty copy starts as this commit's snapshot: its history begins after the commit's parent.
    const empty = !gitOut(["ls-remote", "--heads", COPY_URL, "main"], credentials).trim();
    const migrate = copybara([
      options.sha,
      ...(empty ? ["--force", "--last-rev", parentOf(options.sha)] : []),
      ...pushing,
    ]);
    process.stdout.write(migrate.stderr);
    if (migrate.status === 4)
      console.log(`[copybara] ${REPO}: nothing new to copy up to ${options.sha}`);
    else if (migrate.status !== 0)
      throw new Error(`Copybara's ${WORKFLOW} exited with ${migrate.status || migrate.signal}`);

    // What the copy should hold at `sha`: Copybara writes it to a folder, with the same file
    // selection and transformations as the migration.
    const copy = fetchCopyHead({ credentials, work });
    const expected = join(work, "expected");
    writeToFolder(options.sha, expected);
    checkCopy({ sha: options.sha, expected, copy });

    const clone = join(work, "clone");
    gitOut(["clone", "--quiet", "--depth", "1", COPY_URL, clone], credentials);
    checkSelfHost(clone);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What iterate/os would hold at `sha`, written to a folder and run through the self-host recipe,
 *  pushing nothing: a pull request's check that the copy still installs and builds. */
export async function check(options: {
  /** The commit to copy, which must be on GitHub (Copybara fetches it). */
  sha: string;
}) {
  const work = mkdtempSync(join(tmpdir(), "copybara-check-"));
  try {
    const folder = join(work, REPO);
    writeToFolder(options.sha, folder);
    // the folder as a fresh clone has it: every file committed, so the recipe's `git status` check
    // means what it does there
    for (const args of [
      ["init", "--quiet"],
      ["add", "--all"],
      ["commit", "--quiet", "-m", "copy"],
    ])
      execFileSync(
        "git",
        ["-c", "user.name=copybara", "-c", "user.email=copybara@localhost", ...args],
        {
          cwd: folder,
        },
      );
    checkSelfHost(folder);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Copybara's `migrate` of the os workflow with `args`. */
function copybara(args: string[]) {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) throw new Error("JAVA_HOME is unset: Copybara needs Java 25 or newer");
  return spawnSync(
    join(javaHome, "bin", "java"),
    ["-jar", copybaraJar(), "migrate", CONFIG, WORKFLOW, ...args],
    { encoding: "utf8" },
  );
}

/** What the copy holds at `sha`, as Copybara writes it: the same file selection and
 *  transformations as a migration. */
function writeToFolder(sha: string, folder: string) {
  const run = copybara([sha, "--to-folder", "--folder-dir", folder, "--squash"]);
  if (run.status === 0) return;
  process.stdout.write(run.stderr);
  throw new Error(`Copybara's ${WORKFLOW} --to-folder exited with ${run.status || run.signal}`);
}

/** A git command's output, with the App's token for github.com when `credentials` is given. */
function gitOut(args: string[], credentials?: string) {
  return execFileSync(
    "git",
    [...(credentials ? ["-c", `credential.helper=store --file=${credentials}`] : []), ...args],
    { encoding: "utf8" },
  );
}

/** `sha`'s first parent, from this checkout (a CI checkout is one commit deep: fetched if need be). */
function parentOf(sha: string) {
  execFileSync("git", ["fetch", "--quiet", "--depth=2", "origin", sha], { cwd: REPO_ROOT });
  return execFileSync("git", ["rev-parse", `${sha}^`], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * The self-host recipe (core/os/public/setup-prompt.md) against a checkout of iterate/os, as far
 * as it goes without a Cloudflare account: the install (with --frozen-lockfile, which proves the
 * copy's lockfile), the self-host build, a dry-run deploy, and the SDK imports its later steps run.
 * After all that, `git status` in the checkout must be clean.
 */
function checkSelfHost(checkout: string) {
  const run = (command: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
    console.log(`[copybara] ${REPO}: ${[command, ...args].join(" ")}`);
    execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  };
  run("pnpm", ["install", "--frozen-lockfile"], checkout);
  run("pnpm", ["--filter", "os", "build"], checkout, { CLOUDFLARE_ENV: "self-host" });
  const os = join(checkout, "core/os");
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", "dist/server/wrangler.json", "--dry-run"],
    os,
  );
  run("node", ["--eval", 'Promise.all([import("iterate/node"), import("capnweb")])'], os);
  // and leaves the checkout clean: everything it made is ignored, and nothing tracked changed
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (status.trim())
    throw new Error(
      `the recipe left ${REPO}'s checkout dirty (copybara/os/.gitignore, or an install that rewrites a tracked file):\n${status.split("\n").slice(0, 20).join("\n")}`,
    );
  console.log(`[copybara] ${REPO}: it installs, builds and deploys (dry run), and stays clean`);
}

/**
 * The copy is in sync when its head's tree hash equals the hash of the folder Copybara wrote for
 * `sha`. A git tree hash is a hash of the content alone, so equal hashes mean every file is the
 * same, and a file added by hand shows up too. Only the copy's commits and trees are fetched.
 */
function checkCopy(input: {
  sha: string;
  expected: string;
  copy: ReturnType<typeof fetchCopyHead>;
}) {
  const { git, head, tree } = input.copy;
  git("--work-tree", input.expected, "add", "--all", ".");
  const expectedTree = git("write-tree");
  if (tree !== expectedTree)
    throw new Error(
      `${COPY_URL}/commit/${head} is not what ${input.sha} should copy: ${git("diff-tree", "-r", "--name-status", expectedTree, tree)}`,
    );
  console.log(`[copybara] in sync: ${COPY_URL}/commit/${head} is ${input.sha}'s (tree ${tree})`);
}

/** The copy's main as it is now: its head and its tree. Only the head's commit and trees are
 *  fetched, and its `GitOrigin-RevId` trailer must name the iterate/iterate commit it came from. */
function fetchCopyHead(input: { credentials: string; work: string }) {
  const gitDir = join(input.work, `${REPO}.git`);
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", gitDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: join(input.work, `${REPO}.index`) },
    }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", gitDir]);
  git(
    "-c",
    `credential.helper=store --file=${input.credentials}`,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "--filter=blob:none",
    COPY_URL,
    "main",
  );
  const copiedCommit = git(
    "log",
    "-1",
    "--format=%(trailers:key=GitOrigin-RevId,valueonly)",
    "FETCH_HEAD",
  );
  if (!/^[0-9a-f]{40}$/.test(copiedCommit))
    throw new Error(`${COPY_URL}'s main names no GitOrigin-RevId: ${JSON.stringify(copiedCommit)}`);
  return { git, head: git("rev-parse", "FETCH_HEAD"), tree: git("rev-parse", "FETCH_HEAD^{tree}") };
}

/** The pinned Copybara release's jar, downloaded once per machine and checked against its SHA-256. */
function copybaraJar() {
  const dir = join(tmpdir(), "copybara-jar");
  const jar = join(dir, `copybara-${COPYBARA.version}.jar`);
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (existsSync(jar) && hash(jar) === COPYBARA.sha256) return jar;
  mkdirSync(dir, { recursive: true });
  execFileSync("curl", [
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

/** iterate/os's workspace packages: what copy.bara.sky's `os` workflow copies of this repo's. */
const OS_PACKAGES = ["core/os", "core/lib"];
const OS_WORKSPACE_HEADER =
  "# iterate/os's workspace: generated in iterate's own repo from its pnpm-workspace.yaml, for\n" +
  "# these packages alone, with the same settings and the catalog trimmed to what they use.\n";

/**
 * iterate/os's own pnpm-workspace.yaml and pnpm-lock.yaml (copybara/os/, which Copybara moves to
 * the copy's root). pnpm makes them, in a scratch folder holding the copy's root package.json
 * (copybara/os/package.json, written by hand), this repo's lockfile and workspace file with the
 * copy's packages, those packages' manifests and the patches: `pnpm install --lockfile-only` drops
 * every other package's entries and the catalog entries nothing uses, resolving nothing new.
 * Then every dependency must be one this repo already resolves, at the same version.
 */
export async function root(options: {
  /** Fail when copybara/os/'s files are stale, instead of writing them. */
  check?: boolean;
}) {
  const out = join(REPO_ROOT, "copybara/os");
  const scratch = mkdtempSync(join(tmpdir(), "copybara-root-"));
  try {
    cpSync(join(out, "package.json"), join(scratch, "package.json"));
    cpSync(join(REPO_ROOT, "pnpm-lock.yaml"), join(scratch, "pnpm-lock.yaml"));
    cpSync(join(REPO_ROOT, "patches"), join(scratch, "patches"), { recursive: true });
    for (const pkg of OS_PACKAGES) {
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
        `packages:\n${OS_PACKAGES.map((p) => `  - ${p}\n`).join("")}`,
      ),
    );
    // With an empty metadata cache of its own, pnpm reads each package's manifest from the registry,
    // where a published version never changes, so every machine writes the same lockfile. A
    // laptop's cache once gave crossws@0.4.4 another peer range than CI's, and the check went stale.
    const lockfileOnly = (extra: string[]) =>
      execFileSync(
        "pnpm",
        [
          "install",
          "--lockfile-only",
          "--ignore-scripts",
          `--config.cache-dir=${join(scratch, ".pnpm-cache")}`,
          ...extra,
        ],
        { cwd: scratch, stdio: ["ignore", "ignore", "inherit"] },
      );
    // pnpm refuses a patch for a package nothing installs, and an override naming a catalog entry
    // the catalog no longer has (`cleanupUnusedCatalogs` drops what the copy doesn't use), and this
    // repo patches and overrides packages the copy may not use (@cloudflare/vitest-plugin, once only
    // test/ used it; @codemirror/state, once only packages/ui): resolve once allowing them, then keep
    // the patches and overrides whose package the copy's lockfile resolves.
    lockfileOnly(["--config.allow-unused-patches=true"]);
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
    lockfileOnly([]);
    const files = {
      "pnpm-workspace.yaml":
        OS_WORKSPACE_HEADER + readFileSync(join(scratch, "pnpm-workspace.yaml"), "utf8"),
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
        const diff = spawnSync(
          "git",
          [
            "diff",
            "--no-index",
            "--stat",
            "--patch",
            join(out, name),
            join(scratch, `generated-${name}`),
          ],
          { encoding: "utf8" },
        );
        console.log(diff.stdout.split("\n").slice(0, 120).join("\n"));
      }
      throw new Error(
        `copybara/os/{${stale.map(([name]) => name).join(",")}} are stale: run \`node scripts/ci/copybara.ts root\` and commit them`,
      );
    }
    for (const [name, content] of stale) writeFileSync(join(out, name), content);
    console.log(
      `[copybara] copybara/os/: ${stale.length === 0 ? "current" : `wrote ${stale.map(([name]) => name).join(", ")}`}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The copy resolves nothing this repo doesn't: every package it locks is locked here at the same
 * version with the same integrity, each copied package asks for the same specifiers and gets the
 * same versions, and its root asks for the versions ours does. Peer contexts and `optional` flags
 * may differ, and do: with the other packages gone, a peer they brought in is missing (trpc-cli is
 * locked without the `effect` another package brings) and a package only an optional dependency
 * reaches is marked optional.
 */
function checkSubset(files: { "pnpm-workspace.yaml": string; "pnpm-lock.yaml": string }) {
  type Dependency = { specifier: string; version: string };
  const lock = (text: string) =>
    parseYaml(text) as {
      importers: Record<string, Record<string, Record<string, Dependency>>>;
      packages?: Record<string, { resolution: unknown }>;
      catalogs?: { default?: Record<string, Dependency> };
    };
  // `1.168.58(crossws@0.4.4)(…)` → `1.168.58`: a version without the peers pnpm resolved it with
  const withoutPeers = (dependency: Dependency | undefined) =>
    dependency && { specifier: dependency.specifier, version: dependency.version.split("(")[0] };
  const ours = lock(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));
  const theirs = lock(files["pnpm-lock.yaml"]);
  const problems = [
    ...Object.entries(theirs.packages || {})
      .filter(
        ([key, entry]) => !isDeepStrictEqual(ours.packages?.[key]?.resolution, entry.resolution),
      )
      .map(([key]) => `${key} is not locked here with the same integrity`),
    ...OS_PACKAGES.flatMap((pkg) =>
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
  const rootManifest = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as {
      packageManager: string;
      devDependencies?: Record<string, string>;
    };
  const ourRoot = rootManifest(join(REPO_ROOT, "package.json"));
  const theirRoot = rootManifest(join(REPO_ROOT, "copybara/os/package.json"));
  if (theirRoot.packageManager !== ourRoot.packageManager)
    problems.push(`packageManager ${theirRoot.packageManager} is not ${ourRoot.packageManager}`);
  for (const [name, spec] of Object.entries(theirRoot.devDependencies || {}))
    if (ourRoot.devDependencies?.[name] !== spec)
      problems.push(
        `copybara/os/package.json asks for ${name}@${spec}, this repo for ${ourRoot.devDependencies?.[name]}`,
      );
  if (problems.length > 0)
    throw new Error(
      `iterate/os's dependencies must be a subset of this repo's:\n${problems.join("\n")}`,
    );
}

void createCli({ ...import.meta, name: "copybara" }).run();
