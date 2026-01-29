import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const imageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

function getCommitSha(): string {
  const envSha = process.env.SANDBOX_ITERATE_REPO_REF;
  const sha = envSha ?? execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Could not resolve commit SHA (got: ${sha})`);
  }
  return sha;
}

console.log(`Building local docker snapshot: ${imageName}`);

const tempDir = mkdtempSync(join(tmpdir(), "iterate-sandbox-context-"));
const dockerfilePath = join(tempDir, "Dockerfile");

try {
  const commitSha = getCommitSha();
  console.log(`Bundling repo at ${commitSha}`);
  execSync(`git bundle create ${join(tempDir, "iterate.bundle")} HEAD`, {
    cwd: repoRoot,
    stdio: "inherit",
  });

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
  writeFileSync(dockerfilePath, dockerfileContent);

  const buildArgs = [
    process.argv.includes("--no-cache") ? "--no-cache" : "",
    "--build-arg",
    `SANDBOX_ITERATE_REPO_REF=${commitSha}`,
  ]
    .filter(Boolean)
    .join(" ");

  execSync(`docker build ${buildArgs} -t ${imageName} -f ${dockerfilePath} ${tempDir}`, {
    stdio: "inherit",
  });
  console.log(`Local docker snapshot ready: ${imageName}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
