// THE ONE-WAY COPIES (copybara/copy.bara.sky, tasks/copybara0929-experiment.md).
//
//   node scripts/ci/copybara.ts sync --sha <deployed sha> [--last-rev <sha>]
//   node scripts/ci/copybara.ts root [--check]
//
// `sync` copies iterate/iterate's commits up to a deployed one into each copy's main, then checks
// that each copy holds exactly what it should at that commit, and that a fresh clone of iterate/os
// passes the self-host recipe. Deploy OS runs it after a production deploy. --last-rev starts empty
// copies (Copybara's --force): their history begins after that commit. A run with nothing new to
// copy is a pass (Copybara's exit code 4). Copybara runs on $JAVA_HOME's Java, 25 or newer (its
// jar's class files are version 69; its README's "21" is out of date). It pushes as the iterate
// GitHub App, with a token that can only write the copies (./iterate-app-token.ts). A laptop runs
// it the same way.
//
// `root` writes iterate/os's own pnpm-workspace.yaml and pnpm-lock.yaml into copybara/os/, from
// this repo's, for the copy's packages alone; `--check` fails when they're stale instead.
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
import { parse as parseYaml } from "yaml";
import { iterateAppFromPrd, iterateAppToken } from "./iterate-app-token.ts";

const COPYBARA = {
  version: "v20260928",
  sha256: "25807645ee17b7b863f4f885012b06192b9952632b540bdf8a21088313fe4925",
};
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CONFIG = join(REPO_ROOT, "copybara/copy.bara.sky");
/** copy.bara.sky's workflows and the iterate/<repo> each pushes to. */
const COPIES = { os: "os0929", packages: "packages0929" };
// The App's bot user (`gh api 'users/iterate[bot]'`), so its commits link to it.
const COMMITTER = {
  name: "iterate[bot]",
  email: "233973017+iterate[bot]@users.noreply.github.com",
};

/** Copies the commits up to `sha` into every copy, then checks each copy is `sha`'s. */
export async function sync(options: {
  /** The deployed commit to copy up to. */
  sha: string;
  /** Start empty copies: their history begins after this commit. */
  lastRev?: string;
}) {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) throw new Error("JAVA_HOME is unset: Copybara needs Java 25 or newer");
  const app = await iterateAppToken({
    ...(await iterateAppFromPrd()),
    owner: "iterate",
    repositories: Object.values(COPIES),
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
    const copybaraRun = (args: string[]) =>
      spawnSync(
        join(javaHome, "bin", "java"),
        [
          "-jar",
          copybaraJar(),
          "migrate",
          CONFIG,
          ...args,
          "--git-credential-helper-store-file",
          credentials,
          "--nogit-prompt",
          "--git-committer-name",
          COMMITTER.name,
          "--git-committer-email",
          COMMITTER.email,
        ],
        { encoding: "utf8" },
      );
    for (const [workflow, repo] of Object.entries(COPIES)) {
      const migrate = copybaraRun([
        workflow,
        options.sha,
        ...(options.lastRev ? ["--force", "--last-rev", options.lastRev] : []),
      ]);
      process.stdout.write(migrate.stderr);
      if (migrate.status === 4)
        console.log(`[copybara] ${repo}: nothing new to copy up to ${options.sha}`);
      else if (migrate.status !== 0)
        throw new Error(`Copybara's ${workflow} exited with ${migrate.status || migrate.signal}`);

      // What the copy should hold at `sha`: Copybara writes it to a folder, with the same file
      // selection and moves as the migration.
      const expected = join(work, `${workflow}-expected`);
      const toFolder = copybaraRun([
        workflow,
        options.sha,
        "--to-folder",
        "--folder-dir",
        expected,
        "--squash",
      ]);
      if (toFolder.status !== 0) {
        process.stdout.write(toFolder.stderr);
        throw new Error(`Copybara's ${workflow} --to-folder exited with ${toFolder.status}`);
      }
      checkCopy({ repo, sha: options.sha, expected, credentials, work });
    }
    checkSelfHost({ repo: COPIES.os, credentials, work });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The self-host recipe (apps/os/public/setup-prompt.md) against a fresh clone of iterate/os, as far
 * as it goes without a Cloudflare account: the install (with --frozen-lockfile, which proves the
 * copy's lockfile), the self-host build, a dry-run deploy, and the SDK imports its later steps run.
 * After all that, `git status` in the clone must be clean.
 */
function checkSelfHost(input: { repo: string; credentials: string; work: string }) {
  const clone = join(input.work, `${input.repo}-clone`);
  const run = (command: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
    console.log(`[copybara] ${input.repo}: ${[command, ...args].join(" ")}`);
    execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  };
  run(
    "git",
    [
      "-c",
      `credential.helper=store --file=${input.credentials}`,
      "clone",
      "--quiet",
      "--depth",
      "1",
      `https://github.com/iterate/${input.repo}`,
      clone,
    ],
    input.work,
  );
  run("pnpm", ["install", "--frozen-lockfile"], clone);
  run("pnpm", ["--filter", "os", "build"], clone, { CLOUDFLARE_ENV: "self-host" });
  const os = join(clone, "apps/os");
  run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", "dist/server/wrangler.json", "--dry-run"],
    os,
  );
  run("node", ["--eval", 'Promise.all([import("iterate/node"), import("capnweb")])'], os);
  // and leaves the clone clean: everything it made is ignored, and nothing tracked changed
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: clone, encoding: "utf8" });
  if (status.trim())
    throw new Error(
      `the recipe left ${input.repo}'s clone dirty (copybara/os/.gitignore, or an install that rewrites a tracked file):\n${status.split("\n").slice(0, 20).join("\n")}`,
    );
  console.log(
    `[copybara] ${input.repo}: a fresh clone installs, builds and deploys (dry run), and stays clean`,
  );
}

/**
 * A copy is in sync when its head's tree hash equals the hash of the folder Copybara wrote for
 * `sha`. A git tree hash is a hash of the content alone, so equal hashes mean every file is the
 * same, and a file added by hand shows up too. Only the copy's commits and trees are fetched.
 */
function checkCopy(input: {
  repo: string;
  sha: string;
  expected: string;
  credentials: string;
  work: string;
}) {
  const gitDir = join(input.work, `${input.repo}.git`);
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", gitDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: join(input.work, `${input.repo}.index`) },
    }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", gitDir]);
  git("--work-tree", input.expected, "add", "--all", ".");
  const expectedTree = git("write-tree");
  const url = `https://github.com/iterate/${input.repo}`;
  git(
    "-c",
    `credential.helper=store --file=${input.credentials}`,
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "--filter=blob:none",
    url,
    "main",
  );
  const copyHead = git("rev-parse", "FETCH_HEAD");
  const copyTree = git("rev-parse", "FETCH_HEAD^{tree}");
  if (copyTree !== expectedTree)
    throw new Error(
      `${url}/commit/${copyHead} is not what ${input.sha} should copy: ${git("diff-tree", "-r", "--name-status", expectedTree, copyTree)}`,
    );
  console.log(`[copybara] in sync: ${url}/commit/${copyHead} is ${input.sha}'s (tree ${copyTree})`);
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
const OS_PACKAGES = ["apps/os", "packages/iterate", "packages/shared", "packages/ui"];
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
    execFileSync(
      "pnpm",
      [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        `--config.cache-dir=${join(scratch, ".pnpm-cache")}`,
      ],
      { cwd: scratch, stdio: ["ignore", "ignore", "inherit"] },
    );
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
