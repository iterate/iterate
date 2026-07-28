import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

type CapturedGithubHead = {
  branch: string;
  commitOid: string;
};

type CommandCheck = {
  command: string;
  durationMs: number;
  status: "passed" | "skipped";
};

const GIT_COMMIT_OID = /^[0-9a-f]{40}$/;

type CloneRepository = (input: {
  destination: string;
  owner: string;
  repo: string;
}) => Promise<void> | void;

type ConfigRepository =
  | {
      source: "github";
      installationId: string;
      owner: string;
      repo: string;
      capturedHead: CapturedGithubHead;
    }
  | {
      source: "local";
      capturedHead: CapturedGithubHead;
      files: Array<{ path: string; contentBase64: string }>;
    };

/**
 * Clone and check a config repository without changing either GitHub or OS.
 * The clone seam exists so the network workflow can be covered with a local
 * git fixture; normal callers always use the exact `gh repo clone` command.
 */
export async function preflightConfigRepository(
  input: {
    config: ConfigRepository;
    templateDirectory: string;
  },
  dependencies: { cloneRepository?: CloneRepository } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-project-seed-preflight-"));
  const checkout = join(directory, "config");
  try {
    await mkdir(join(directory, "home"), { mode: 0o700 });
    let branch: string;
    let commitOid: string;
    let fullName: string;
    let captured:
      | Awaited<ReturnType<typeof compareCapturedHead>>
      | (CapturedGithubHead & {
          relation: "local-snapshot";
          commitsSinceCapture: [];
        });
    if (input.config.source === "github") {
      await (dependencies.cloneRepository ?? cloneGithubRepository)({
        destination: checkout,
        owner: input.config.owner,
        repo: input.config.repo,
      });
      const [currentBranch, currentCommitOid, status] = await Promise.all([
        git(checkout, ["branch", "--show-current"]),
        git(checkout, ["rev-parse", "HEAD"]),
        git(checkout, ["status", "--porcelain"]),
      ]);
      if (status !== "") {
        throw new Error(`Fresh config-repo clone is unexpectedly dirty:\n${status}`);
      }
      if (!GIT_COMMIT_OID.test(currentCommitOid)) {
        throw new Error(
          `Git returned an invalid config-repo HEAD: ${JSON.stringify(currentCommitOid)}.`,
        );
      }
      branch = currentBranch;
      commitOid = currentCommitOid;
      fullName = `${input.config.owner}/${input.config.repo}`;
      captured = await compareCapturedHead({
        captured: input.config.capturedHead,
        checkout,
        current: { branch, commitOid },
      });
    } else {
      await materializeLocalRepository(checkout, input.config.files);
      branch = input.config.capturedHead.branch;
      commitOid = input.config.capturedHead.commitOid;
      fullName = "local archive snapshot";
      captured = {
        ...input.config.capturedHead,
        relation: "local-snapshot",
        commitsSinceCapture: [],
      };
    }
    const template = await compareTemplateCompatibility({
      checkout,
      templateDirectory: input.templateDirectory,
    });
    const checks = await runRepositoryChecks(checkout);
    const requiredMigrations = await requiredConfigRepoMigrations(checkout);

    return {
      ready: requiredMigrations.length === 0,
      source: input.config.source,
      repository: {
        fullName,
        branch,
        commitOid,
      },
      captured,
      checks,
      requiredMigrations,
      template,
      guidance:
        requiredMigrations.length === 0
          ? input.config.source === "local"
            ? "The archived local config snapshot passed every compatibility check."
            : captured.commitsSinceCapture.length === 0
              ? "The captured GitHub head is still current and every compatibility check passed."
              : "GitHub has moved since capture, but every current compatibility check passed; restore will adopt the current GitHub head."
          : "Apply the required config-repo migrations through a separately authorized GitHub change before restoring.",
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function materializeLocalRepository(
  destination: string,
  files: readonly { path: string; contentBase64: string }[],
) {
  const root = resolve(destination);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(`${root}${sep}`)) {
      throw new Error(`Local repository path escapes its checkout: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
  }
}

async function cloneGithubRepository(input: { destination: string; owner: string; repo: string }) {
  runCommand(
    "gh",
    [
      "repo",
      "clone",
      `${input.owner}/${input.repo}`,
      input.destination,
      "--",
      "--filter=blob:none",
      "--single-branch",
    ],
    undefined,
    120_000,
    githubCliEnvironment(),
  );
}

async function compareCapturedHead(input: {
  captured: CapturedGithubHead;
  checkout: string;
  current: CapturedGithubHead;
}) {
  if (!GIT_COMMIT_OID.test(input.captured.commitOid)) {
    throw new Error(
      `Archive contains an invalid captured GitHub commit: ${JSON.stringify(input.captured.commitOid)}.`,
    );
  }
  if (input.captured.branch !== input.current.branch) {
    throw new Error(
      `Config repository default branch changed from ${input.captured.branch} to ${input.current.branch}; review that change before restore.`,
    );
  }
  if (input.captured.commitOid === input.current.commitOid) {
    return {
      ...input.captured,
      relation: "same" as const,
      commitsSinceCapture: [] as Array<{
        committedAt: string;
        commitOid: string;
        subject: string;
      }>,
    };
  }

  const capturedExists = tryGit(input.checkout, [
    "cat-file",
    "-e",
    `${input.captured.commitOid}^{commit}`,
  ]);
  if (!capturedExists) {
    throw new Error(
      `Captured config commit ${input.captured.commitOid} is no longer reachable from the cloned default-branch history; inspect GitHub before restore.`,
    );
  }
  const isAncestor = tryGit(input.checkout, [
    "merge-base",
    "--is-ancestor",
    input.captured.commitOid,
    input.current.commitOid,
  ]);
  if (!isAncestor) {
    throw new Error(
      `Current config head ${input.current.commitOid} does not descend from captured working head ${input.captured.commitOid}; inspect the force-push or branch rewrite before restore.`,
    );
  }

  const count = Number.parseInt(
    await git(input.checkout, [
      "rev-list",
      "--count",
      `${input.captured.commitOid}..${input.current.commitOid}`,
    ]),
    10,
  );
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Git returned an invalid commit count for the config-repo comparison.");
  }
  const log = await git(input.checkout, [
    "log",
    "--format=%H%x00%aI%x00%s%x00",
    `--max-count=${Math.min(count, 100)}`,
    `${input.captured.commitOid}..${input.current.commitOid}`,
  ]);

  return {
    ...input.captured,
    relation: "current-descends-from-capture" as const,
    totalCommitsSinceCapture: count,
    commitsSinceCapture: parseGitLog(log),
    commitsTruncated: count > 100,
  };
}

export function parseGitLog(output: string) {
  const fields = output.split("\0");
  while (fields.at(-1)?.trim() === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("Git log output did not contain complete commit records.");
  }
  const commits: Array<{ committedAt: string; commitOid: string; subject: string }> = [];
  for (let index = 0; index < fields.length; index += 3) {
    commits.push({
      commitOid: fields[index]!.trim(),
      committedAt: fields[index + 1]!.trim(),
      subject: fields[index + 2]!.trim(),
    });
  }
  return commits;
}

async function compareTemplateCompatibility(input: {
  checkout: string;
  templateDirectory: string;
}) {
  const [configManifest, templateManifest] = await Promise.all([
    readJsonObject(join(input.checkout, "package.json")),
    readJsonObject(join(input.templateDirectory, "package.json")),
  ]);
  const [configTsconfig, templateTsconfig, configWorker, templateWorker] = await Promise.all([
    readFileIfPresent(join(input.checkout, "tsconfig.json")),
    readFileIfPresent(join(input.templateDirectory, "tsconfig.json")),
    readFileIfPresent(join(input.checkout, "worker.ts")),
    readFileIfPresent(join(input.templateDirectory, "worker.ts")),
  ]);
  if (configWorker === null) {
    throw new Error("Config repository has no worker.ts entrypoint.");
  }

  return {
    classification: "informational-not-a-merge-plan" as const,
    packageDependencies: compareDependencies(configManifest, templateManifest),
    tsconfig: compareOptionalText(configTsconfig, templateTsconfig),
    worker: compareOptionalText(configWorker, templateWorker),
    explanation:
      "Project config repositories intentionally diverge from the starter template. Only explicit migration rules and failing install/typecheck/test checks are blockers; a raw template difference is not.",
  };
}

export function compareDependencies(
  configManifest: Record<string, unknown>,
  templateManifest: Record<string, unknown>,
) {
  const config = dependencyMap(configManifest);
  const template = dependencyMap(templateManifest);
  const missing = [...template.keys()].filter((name) => !config.has(name)).sort();
  const additional = [...config.keys()].filter((name) => !template.has(name)).sort();
  const different = [...template.keys()]
    .filter((name) => config.has(name) && config.get(name) !== template.get(name))
    .sort()
    .map((name) => ({
      name,
      config: config.get(name)!,
      template: template.get(name)!,
    }));
  return { additional, different, missing };
}

function dependencyMap(manifest: Record<string, unknown>) {
  const dependencies = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const value = manifest[field];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec === "string") dependencies.set(name, spec);
    }
  }
  return dependencies;
}

async function runRepositoryChecks(checkout: string): Promise<CommandCheck[]> {
  const manifest = await readJsonObject(join(checkout, "package.json"));
  const scripts =
    manifest.scripts !== null &&
    typeof manifest.scripts === "object" &&
    !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const hasLockfile = await fileExists(join(checkout, "pnpm-lock.yaml"));
  const checks: CommandCheck[] = [];
  checks.push(
    timedCommand(
      checkout,
      "pnpm",
      ["install", "--ignore-workspace", ...(hasLockfile ? ["--frozen-lockfile"] : [])],
      300_000,
    ),
  );
  if (typeof scripts.typecheck === "string") {
    checks.push(timedCommand(checkout, "pnpm", ["run", "typecheck"], 300_000));
  } else if (await fileExists(join(checkout, "tsconfig.json"))) {
    checks.push(timedCommand(checkout, "pnpm", ["exec", "tsc", "--noEmit"], 300_000));
  } else {
    checks.push({
      command: "typecheck (no script or tsconfig.json)",
      durationMs: 0,
      status: "skipped",
    });
  }
  if (typeof scripts.test === "string") {
    checks.push(timedCommand(checkout, "pnpm", ["test"], 300_000));
  } else {
    checks.push({ command: "test (no package script)", durationMs: 0, status: "skipped" });
  }
  return checks;
}

function timedCommand(cwd: string, command: string, args: string[], timeout: number): CommandCheck {
  const startedAt = Date.now();
  runCommand(command, args, cwd, timeout, repositoryCommandEnvironment(cwd));
  return {
    command: [command, ...args].join(" "),
    durationMs: Date.now() - startedAt,
    status: "passed",
  };
}

async function requiredConfigRepoMigrations(
  _checkout: string,
): Promise<Array<{ id: string; instruction: string }>> {
  // When an OS/SDK/template change genuinely requires existing config repos to
  // change, add a deterministic inspection rule here in the same PR. Do not
  // infer migrations from a raw template diff: customized workers are normal.
  return [];
}

/*
 * Install hooks and config-repo checks run with a deliberately small
 * environment. In particular, Doppler's production secrets are never exposed
 * to dependency or repository scripts.
 */
function repositoryCommandEnvironment(cwd: string) {
  const sandboxHome = join(cwd, "..", "home");
  return {
    ...selectedEnvironment([
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "PNPM_HOME",
      "SSL_CERT_FILE",
      "TERM",
      "TMPDIR",
      "TZ",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]),
    HOME: sandboxHome,
    XDG_CACHE_HOME: join(sandboxHome, ".cache"),
    XDG_CONFIG_HOME: join(sandboxHome, ".config"),
    XDG_DATA_HOME: join(sandboxHome, ".local", "share"),
  };
}

function githubCliEnvironment() {
  return selectedEnvironment([
    "GH_CONFIG_DIR",
    "GH_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "SSL_CERT_FILE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
}

function selectedEnvironment(names: readonly string[]) {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read valid JSON object from ${path}: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function readFileIfPresent(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function compareOptionalText(config: string | null, template: string | null) {
  if (config === null) return "missing" as const;
  if (template === null) return "template-missing" as const;
  return config === template ? ("same" as const) : ("different" as const);
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]) {
  return runCommand("git", args, cwd, 60_000, repositoryCommandEnvironment(cwd));
}

function tryGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: repositoryCommandEnvironment(cwd),
    stdio: "pipe",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number,
  env?: NodeJS.ProcessEnv,
) {
  const result = spawnSync(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    ...(env === undefined ? {} : { env }),
    maxBuffer: 10 * 1024 * 1024,
    stdio: "pipe",
    timeout,
  });
  if (result.error) {
    throw new Error(`${[command, ...args].join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n")
      .slice(-8_000);
    throw new Error(
      `${[command, ...args].join(" ")} failed with status ${result.status}.${detail ? `\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}
