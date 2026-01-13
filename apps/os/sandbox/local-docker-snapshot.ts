import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const dockerfilePath = join(scriptDir, "Dockerfile");
const imageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

console.log(`Building local docker snapshot: ${imageName}`);
execSync(`docker build -t ${imageName} -f ${dockerfilePath} ${repoRoot}`, { stdio: "inherit" });
console.log(`Local docker snapshot ready: ${imageName}`);
