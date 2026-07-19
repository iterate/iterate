import { createHash } from "node:crypto";

const reusableProjectFamilyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Stable inside one test generation, different across deployments/workflow
 * attempts. This lets parallel workers converge without sending a new Worker
 * version's first traffic through Durable Objects created by an older one.
 */
export function reusableAdminProjectIdentity(input: {
  baseUrl: string;
  family: string;
  generation: string;
}) {
  if (!reusableProjectFamilyPattern.test(input.family)) {
    throw new Error(`Reusable project family must be a slug fragment; received ${input.family}.`);
  }
  if (input.generation.trim().length === 0) {
    throw new Error("Reusable project generation must not be empty.");
  }

  const origin = new URL(input.baseUrl).origin;
  const identityHash = createHash("sha256")
    .update(`${origin}\0${input.generation}\0${input.family}`)
    .digest("hex");
  const slug = `e2e-${input.family}-${identityHash.slice(0, 10)}`;
  if (slug.length > 50) {
    throw new Error(`Reusable project family is too long for a project slug: ${input.family}.`);
  }
  return {
    id: `prj_${identityHash.slice(0, 32)}`,
    origin,
    slug,
  };
}

/** Direct Playwright invocations do not pass through `preview test`. */
export function resolveReusableAdminProjectGeneration(env: NodeJS.ProcessEnv): string {
  const explicit = env.PREVIEW_TEST_GENERATION?.trim();
  if (explicit) return explicit;

  const runId = env.GITHUB_RUN_ID?.trim();
  if (runId) {
    return `github-${runId}-attempt-${env.GITHUB_RUN_ATTEMPT?.trim() || "1"}`;
  }
  return "local-direct";
}
