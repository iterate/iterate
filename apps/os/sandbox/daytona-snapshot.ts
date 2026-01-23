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

const snapshotName = `iterate-sandbox-${commitSha}`;

console.log(`Creating snapshot: ${snapshotName}`);

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

const repoRoot = join(import.meta.dirname, "..", "..", "..");
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
