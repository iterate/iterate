import { execSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

// Daytona snapshots require a commit SHA - ensures reproducible builds
const commitSha = process.env.SANDBOX_ITERATE_REPO_REF;
if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
  console.error("ERROR: SANDBOX_ITERATE_REPO_REF must be a 40-char commit SHA.");
  console.error("");
  console.error("Usage: SANDBOX_ITERATE_REPO_REF=$(git rev-parse HEAD) pnpm snapshot:daytona");
  console.error("");
  if (commitSha) {
    console.error(`Got: ${commitSha}`);
  }
  process.exit(1);
}

// Check if the commit exists on the remote (required for Daytona to clone)
try {
  execSync(`git cat-file -e ${commitSha}^{commit}`, { cwd: repoRoot, stdio: "pipe" });
  // Check if the commit is on origin
  const remoteBranches = execSync(`git branch -r --contains ${commitSha}`, {
    cwd: repoRoot,
    stdio: "pipe",
  })
    .toString()
    .trim();
  if (!remoteBranches) {
    console.error(
      `ERROR: Commit ${commitSha} exists locally but is not pushed to any remote branch.`,
    );
    console.error("");
    console.error(
      "The Daytona build will fail because it clones from GitHub and won't find this commit.",
    );
    console.error("Push your changes first: git push");
    process.exit(1);
  }
} catch {
  console.error(`ERROR: Commit ${commitSha} does not exist in this repository.`);
  process.exit(1);
}

const forceRebuild = process.argv.includes("--force");
const snapshotName = `iterate-sandbox-${commitSha}`;

console.log(`Creating snapshot: ${snapshotName}`);

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});
const dockerfileSourcePath = join(import.meta.dirname, "Dockerfile");
const tempDir = mkdtempSync(join(tmpdir(), "iterate-sandbox-context-"));
const dockerfileTargetPath = join(tempDir, "Dockerfile");

const trackedFiles = execSync("git ls-files -z", { cwd: repoRoot })
  .toString("utf-8")
  .split("\u0000")
  .filter(Boolean);
const untrackedFiles = execSync("git ls-files -z --others --exclude-standard", { cwd: repoRoot })
  .toString("utf-8")
  .split("\u0000")
  .filter(Boolean);
const files = new Set([...trackedFiles, ...untrackedFiles]);

for (const relativePath of files) {
  const sourcePath = join(repoRoot, relativePath);
  const targetPath = join(tempDir, relativePath);
  const parentDir = dirname(targetPath);
  if (!existsSync(sourcePath)) {
    continue;
  }
  const stats = lstatSync(sourcePath);

  mkdirSync(parentDir, { recursive: true });

  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), targetPath);
    continue;
  }

  if (stats.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    chmodSync(targetPath, stats.mode);
    continue;
  }

  copyFileSync(sourcePath, targetPath);
  // Mask out setuid/setgid bits (04000/02000) to prevent privilege escalation
  chmodSync(targetPath, stats.mode & 0o777);
}

// Read Dockerfile and inject the git ref into ALL ARG declarations
// Docker ARG values don't persist across USER switches, so both declarations need the value
let dockerfileContent = readFileSync(dockerfileSourcePath, "utf-8");

console.log(`Using SANDBOX_ITERATE_REPO_REF=${commitSha}`);
// Replace all ARG SANDBOX_ITERATE_REPO_REF declarations (with or without default value)
dockerfileContent = dockerfileContent.replace(
  /^ARG SANDBOX_ITERATE_REPO_REF(=.*)?$/gm,
  `ARG SANDBOX_ITERATE_REPO_REF="${commitSha}"`,
);

writeFileSync(dockerfileTargetPath, dockerfileContent);

const image = Image.fromDockerfile(dockerfileTargetPath);

const snapshot = await (async () => {
  try {
    // Delete existing snapshot if --force flag is passed
    if (forceRebuild) {
      console.log(`--force: Deleting existing snapshot ${snapshotName} if it exists...`);
      try {
        const existing = await daytona.snapshot.get(snapshotName);
        await daytona.snapshot.delete(existing);
        console.log(`Deleted existing snapshot ${snapshotName}`);
        // Wait for deletion to propagate - poll until 404 or timeout
        console.log(`Waiting for deletion to propagate...`);
        const maxWaitMs = 30_000;
        const pollIntervalMs = 2_000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          try {
            await daytona.snapshot.get(snapshotName);
            // Still exists, keep waiting
            process.stdout.write(".");
          } catch (pollError) {
            if (
              pollError instanceof Error &&
              "statusCode" in pollError &&
              pollError.statusCode === 404
            ) {
              console.log(" deleted!");
              break;
            }
            throw pollError;
          }
        }
      } catch (deleteError) {
        // Ignore 404 errors (snapshot doesn't exist)
        if (
          deleteError instanceof Error &&
          "statusCode" in deleteError &&
          deleteError.statusCode === 404
        ) {
          console.log(`Snapshot ${snapshotName} doesn't exist, nothing to delete`);
        } else {
          throw deleteError;
        }
      }
    }

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
    // But if --force was used, this means delete didn't work properly
    if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
      if (forceRebuild) {
        console.error(
          `ERROR: Snapshot ${snapshotName} still exists after delete. The Daytona API may have a propagation delay.`,
        );
        console.error(`Try again in a few seconds, or delete manually via the Daytona dashboard.`);
        throw error;
      }
      console.log(`Snapshot ${snapshotName} already exists, skipping creation`);
      return { name: snapshotName, alreadyExisted: true };
    }
    throw error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
})();

console.log("Snapshot created successfully:", snapshot);
