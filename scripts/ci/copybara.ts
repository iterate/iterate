// THE COPYBARA COPY OF packages/ (copybara/copy.bara.sky, tasks/copybara0929-experiment.md): copies
// iterate/iterate's commits up to a deployed one to iterate/copybara0929's main, then checks that
// the copy's packages/ and README are that commit's. Deploy OS runs it after each production deploy.
//
//   node scripts/ci/copybara.ts --workflow copybara0929 --sha <deployed sha> [--last-rev <sha>]
//
// --last-rev starts an empty copy (Copybara's --force): its history begins after that commit. A run
// with nothing new to copy is a pass (Copybara's exit code 4). Copybara runs on $JAVA_HOME's Java,
// 25 or newer (its jar's class files are version 69; its README's "21" is out of date). It pushes
// as the iterate GitHub App, with a token that can only write the copy (./iterate-app-token.ts). A
// laptop runs it the same way.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { iterateAppFromPrd, iterateAppToken } from "./iterate-app-token.ts";

const COPYBARA = {
  version: "v20260928",
  sha256: "25807645ee17b7b863f4f885012b06192b9952632b540bdf8a21088313fe4925",
};
const CONFIG = resolve(import.meta.dirname, "../../copybara/copy.bara.sky");
const COPY = { owner: "iterate", repo: "copybara0929" };
const COPY_URL = `https://github.com/${COPY.owner}/${COPY.repo}`;
// The App's bot user (`gh api 'users/iterate[bot]'`), so its commits link to it.
const COMMITTER = {
  name: "iterate[bot]",
  email: "233973017+iterate[bot]@users.noreply.github.com",
};

/** Copies the commits up to `sha` into the copy, then checks the copy is `sha`'s packages/. */
export default async function copybara(options: {
  /** The copy.bara.sky workflow: `copybara0929`. */
  workflow: string;
  /** The deployed commit to copy up to. */
  sha: string;
  /** Start an empty copy: its history begins after this commit. */
  lastRev?: string;
}) {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) throw new Error("JAVA_HOME is unset: Copybara needs Java 25 or newer");
  const java = join(javaHome, "bin", "java");
  const app = await iterateAppToken({
    ...(await iterateAppFromPrd()),
    ...COPY,
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
    const migrate = spawnSync(
      java,
      [
        "-jar",
        copybaraJar(),
        "migrate",
        CONFIG,
        options.workflow,
        options.sha,
        "--git-credential-helper-store-file",
        credentials,
        "--nogit-prompt",
        "--git-committer-name",
        COMMITTER.name,
        "--git-committer-email",
        COMMITTER.email,
        ...(options.lastRev ? ["--force", "--last-rev", options.lastRev] : []),
      ],
      { stdio: "inherit" },
    );
    if (migrate.status === 4) console.log(`[copybara] nothing new to copy up to ${options.sha}`);
    else if (migrate.status !== 0)
      throw new Error(`Copybara exited with ${migrate.status ?? migrate.signal}`);
    checkCopy({ sha: options.sha, credentials, gitDir: join(work, "check.git") });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The copy is `sha`'s packages/ and README when three tree hashes agree: the copy's head, the origin
 * commit its `GitOrigin-RevId` trailer names, and `sha` (commits after the trailer's touched neither).
 * A git tree hash is a hash of the content alone, so comparing hashes compares every file. Only
 * commits and trees are fetched.
 */
function checkCopy(input: { sha: string; credentials: string; gitDir: string }) {
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", input.gitDir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", input.gitDir]);
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
  const copyHead = git("rev-parse", "FETCH_HEAD");
  const trailer = /^GitOrigin-RevId: ([0-9a-f]{40})$/mu.exec(
    git("log", "-1", "--format=%B", copyHead),
  );
  if (!trailer) throw new Error(`the copy's head ${copyHead} has no GitOrigin-RevId trailer`);
  const originRev = trailer[1]!;
  git(
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "--filter=blob:none",
    "https://github.com/iterate/iterate",
    originRev,
    input.sha,
  );
  const hashes = {
    packages: {
      copy: git("rev-parse", `${copyHead}:packages`),
      trailer: git("rev-parse", `${originRev}:packages`),
      sha: git("rev-parse", `${input.sha}:packages`),
    },
    readme: {
      copy: git("rev-parse", `${copyHead}:README.md`),
      trailer: git("rev-parse", `${originRev}:copybara/copybara0929/README.md`),
      sha: git("rev-parse", `${input.sha}:copybara/copybara0929/README.md`),
    },
  };
  const differ = Object.entries(hashes).filter(
    ([, { copy, trailer, sha }]) => copy !== trailer || trailer !== sha,
  );
  if (differ.length > 0)
    throw new Error(
      `the copy's head ${copyHead} (from ${originRev}) is not ${input.sha}: ${JSON.stringify(Object.fromEntries(differ))}`,
    );
  console.log(
    `[copybara] in sync: ${COPY_URL}/commit/${copyHead} has ${input.sha}'s packages/ (tree ${hashes.packages.copy}) and README`,
  );
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

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "copybara" }).run();
