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

// Daytona snapshots MUST have a git ref - there's no local mount to sync from
const repoRef = process.env.SANDBOX_ITERATE_REPO_REF;
if (!repoRef) {
  console.error("ERROR: SANDBOX_ITERATE_REPO_REF is required for Daytona snapshots.");
  console.error("");
  console.error("Daytona snapshots must include the iterate repo baked in.");
  console.error("Set SANDBOX_ITERATE_REPO_REF to a branch name or commit SHA:");
  console.error("");
  console.error("  SANDBOX_ITERATE_REPO_REF=main pnpm snapshot:daytona:prd");
  console.error("  SANDBOX_ITERATE_REPO_REF=$(git rev-parse HEAD) pnpm snapshot:daytona:prd");
  console.error("");
  process.exit(1);
}

const stage = getStage();
// Generate snapshot name: <stage>--<timestamp>
// e.g., "dev-jonas--20260111-193045", "stg--20260111-193045"
const snapshotName = `${stage}--${generateTimestamp()}`;

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

console.log(`Using SANDBOX_ITERATE_REPO_REF=${repoRef}`);
// Replace all ARG SANDBOX_ITERATE_REPO_REF declarations (with or without default value)
dockerfileContent = dockerfileContent.replace(
  /^ARG SANDBOX_ITERATE_REPO_REF(=.*)?$/gm,
  `ARG SANDBOX_ITERATE_REPO_REF="${repoRef}"`,
);

writeFileSync(dockerfileTargetPath, dockerfileContent);

const image = Image.fromDockerfile(dockerfileTargetPath);

const snapshot = await (async () => {
  try {
    return await daytona.snapshot.create(
      { name: snapshotName, image, resources: { cpu: 4, memory: 4, disk: 10 } },
      { onLogs: console.log },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
})();

console.log("Snapshot created successfully:", snapshot);

function getStage(): string {
  const iterateUser = process.env.ITERATE_USER;
  const appStage = process.env.APP_STAGE;

  if (iterateUser && iterateUser !== "unknown") {
    return `dev-${iterateUser}`;
  }

  if (appStage) {
    return appStage;
  }

  throw new Error("Cannot determine stage: set ITERATE_USER for dev or APP_STAGE for stg/prd");
}

function generateTimestamp(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
