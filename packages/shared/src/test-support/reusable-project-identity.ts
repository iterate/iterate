import { createHash } from "node:crypto";

const reusableProjectFamilyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive one project identity that all test workers in a generation can use.
 * The deployment origin prevents preview slots from sharing an Auth identity;
 * the generation rotates identities when a new deployment/workflow needs
 * fresh Durable Objects.
 */
export function reusableProjectIdentity(input: {
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

/** Direct Playwright/Vitest invocations do not pass through `preview test`. */
export function resolveReusableProjectGeneration(env: NodeJS.ProcessEnv): string {
  const explicit = env.PREVIEW_TEST_GENERATION?.trim();
  if (explicit) return explicit;

  const runId = env.GITHUB_RUN_ID?.trim();
  if (runId) {
    return `github-${runId}-attempt-${env.GITHUB_RUN_ATTEMPT?.trim() || "1"}`;
  }
  return "local-direct";
}
