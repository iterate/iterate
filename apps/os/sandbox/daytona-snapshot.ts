import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function getCommitSha(): string {
  const envSha = process.env.SANDBOX_ITERATE_REPO_REF;
  const sha = envSha ?? execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    console.error("ERROR: Could not resolve a 40-char commit SHA.");
    console.error("");
    console.error("Usage: git rev-parse HEAD (or set SANDBOX_ITERATE_REPO_REF to a SHA)");
    console.error("");
    console.error(`Got: ${sha}`);
    process.exit(1);
  }
  return sha;
}

function getBranchName(): string | null {
  try {
    const branch = execSync("git symbolic-ref --short -q HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    if (!branch) return null;
    execSync(`git check-ref-format --branch ${branch}`, { cwd: repoRoot, stdio: "ignore" });
    return branch;
  } catch {
    return null;
  }
}

function injectBuildArgs(
  dockerfileContent: string,
  commitSha: string,
  branchName: string | null,
): string {
  let next = dockerfileContent.replaceAll(
    "ARG SANDBOX_ITERATE_REPO_REF",
    `ARG SANDBOX_ITERATE_REPO_REF="${commitSha}"`,
  );
  if (!next.includes(`ARG SANDBOX_ITERATE_REPO_REF="${commitSha}"`)) {
    throw new Error("Failed to inject SANDBOX_ITERATE_REPO_REF into Dockerfile");
  }
  if (branchName) {
    next = next.replaceAll(
      "ARG SANDBOX_ITERATE_BRANCH",
      `ARG SANDBOX_ITERATE_BRANCH="${branchName}"`,
    );
    if (!next.includes(`ARG SANDBOX_ITERATE_BRANCH="${branchName}"`)) {
      throw new Error("Failed to inject SANDBOX_ITERATE_BRANCH into Dockerfile");
    }
  }
  return next;
}

const commitSha = getCommitSha();
const branchName = getBranchName();
const snapshotName = `iterate-sandbox-${commitSha}`;

console.log(`Creating snapshot: ${snapshotName}`);

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

const tempDir = mkdtempSync(join(tmpdir(), "iterate-sandbox-context-"));
const dockerfileTargetPath = join(tempDir, "Dockerfile");

try {
  // Create git bundle from committed state (works with worktrees)
  console.log(`Bundling repo at ${commitSha}`);
  execSync(`git bundle create ${join(tempDir, "iterate.bundle")} HEAD`, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // Materialize entry.sh from committed state into build context
  const entryPath = join(tempDir, "apps/os/sandbox");
  mkdirSync(entryPath, { recursive: true });
  const entryContent = execSync("git show HEAD:apps/os/sandbox/entry.sh", {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  const entryFile = join(entryPath, "entry.sh");
  writeFileSync(entryFile, entryContent);
  chmodSync(entryFile, 0o755);

  const dockerfileContent = execSync("git show HEAD:apps/os/sandbox/Dockerfile", {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  writeFileSync(dockerfileTargetPath, injectBuildArgs(dockerfileContent, commitSha, branchName));

  const image = Image.fromDockerfile(dockerfileTargetPath);

  const snapshot = await (async () => {
    try {
      return await daytona.snapshot.create(
        {
          name: snapshotName,
          image,
          resources: { cpu: 2, memory: 4, disk: 10 },
        },
        { onLogs: console.log },
      );
    } catch (error) {
      // Handle "already exists" as success (409 conflict) - snapshots are idempotent by commit SHA
      if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
        console.log(`Snapshot ${snapshotName} already exists, skipping creation`);
        return { name: snapshotName, alreadyExisted: true };
      }
      throw error;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();

  console.log("Snapshot created successfully:", snapshot);
} catch (error) {
  rmSync(tempDir, { recursive: true, force: true });
  throw error;
}
