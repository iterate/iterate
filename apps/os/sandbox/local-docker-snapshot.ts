import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const dockerfilePath = join(scriptDir, "Dockerfile");
const imageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

const buildArgs: string[] = [];
buildArgs.push(`--build-arg ITERATE_MACHINE_PROVIDER=local-docker`);
if (process.env.SANDBOX_ITERATE_REPO_REF) {
  console.log(`Using SANDBOX_ITERATE_REPO_REF=${process.env.SANDBOX_ITERATE_REPO_REF}`);
  buildArgs.push(`--build-arg SANDBOX_ITERATE_REPO_REF="${process.env.SANDBOX_ITERATE_REPO_REF}"`);
}

console.log(`Building local docker snapshot: ${imageName}`);
execSync(
  `docker build --target sandbox-local ${buildArgs.join(" ")} -t ${imageName} -f ${dockerfilePath} ${repoRoot}`,
  {
    stdio: "inherit",
  },
);
console.log(`Local docker snapshot ready: ${imageName}`);
