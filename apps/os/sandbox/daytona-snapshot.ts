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

writeFileSync(dockerfileTargetPath, readFileSync(dockerfileSourcePath, "utf-8"));

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
