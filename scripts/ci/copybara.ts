// THE ONE-WAY COPIES (copybara/copy.bara.sky, tasks/copybara0929-experiment.md): copies
// iterate/iterate's commits up to a deployed one into each copy's main, then checks that each copy
// holds exactly what it should at that commit. Deploy OS runs it after a production deploy.
//
//   node scripts/ci/copybara.ts --sha <deployed sha> [--last-rev <sha>]
//
// --last-rev starts empty copies (Copybara's --force): their history begins after that commit. A
// run with nothing new to copy is a pass (Copybara's exit code 4). Copybara runs on $JAVA_HOME's
// Java, 25 or newer (its jar's class files are version 69; its README's "21" is out of date). It
// pushes as the iterate GitHub App, with a token that can only write the copies
// (./iterate-app-token.ts). A laptop runs it the same way.
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
/** copy.bara.sky's workflows and the iterate/<repo> each pushes to. */
const COPIES = { os: "os0929", packages: "packages0929" };
// The App's bot user (`gh api 'users/iterate[bot]'`), so its commits link to it.
const COMMITTER = {
  name: "iterate[bot]",
  email: "233973017+iterate[bot]@users.noreply.github.com",
};

/** Copies the commits up to `sha` into every copy, then checks each copy is `sha`'s. */
export default async function copybara(options: {
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
        throw new Error(`Copybara's ${workflow} exited with ${migrate.status ?? migrate.signal}`);

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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "copybara" }).run();
