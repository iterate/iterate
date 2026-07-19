import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SHARED_CONTAINER_INPUTS = [
  "apps/os/package.json",
  "apps/os/sandbox/Dockerfile",
  "apps/os/scripts/container-class-names.ts",
  "apps/os/scripts/deployment-revisions.ts",
  "apps/os/scripts/generate-wrangler-config.ts",
  "apps/os/src/domains/sandboxes/instance-types.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

/**
 * Immutable identity of the route-less worker-builder deployment.
 *
 * This deliberately follows the builder's inputs rather than the pull-request
 * head. Unrelated OS changes can therefore keep the deployment-global
 * coordinator, queue, and warm stock-sandbox pool alive. The input set is
 * conservative: the whole workers domain and lockfile may cause an extra
 * redeploy, but can never incorrectly reuse a stale builder bundle.
 */
export function workerBuildDeploymentId(): string {
  return contentRevision("worker-builder", [
    ...SHARED_CONTAINER_INPUTS,
    "apps/os/src/domains/workers",
    "apps/os/src/worker-builder.ts",
  ]);
}

/** Immutable identity of the main Worker's stock-sandbox container config. */
export function sandboxContainerDeploymentId(): string {
  return contentRevision("sandbox-containers", SHARED_CONTAINER_INPUTS);
}

function contentRevision(prefix: string, inputs: readonly string[]): string {
  const hash = createHash("sha256");
  const files = inputs.flatMap((input) => filesUnder(resolve(REPO_ROOT, input))).sort();

  for (const file of files) {
    const repoRelativePath = relative(REPO_ROOT, file);
    hash.update(repoRelativePath);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  return `${prefix}-${hash.digest("hex").slice(0, 32)}`;
}

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : entry.isFile() ? [child] : [];
  });
}
