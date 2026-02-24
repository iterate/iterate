import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const imageTag = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland5-sandbox:local";
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

console.log(`Building ${imageTag} (git=${gitSha})`);

execFileSync(
  "docker",
  [
    "buildx",
    "build",
    "--load",
    "-f",
    "jonasland5/sandbox/Dockerfile",
    "-t",
    imageTag,
    "--build-arg",
    `GIT_SHA=${gitSha}`,
    ".",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

console.log(`Built image: ${imageTag}`);
