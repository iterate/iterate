/**
 * The one observability posture every Iterate worker deploys with: full
 * sampling, persistent logs and traces. Shared by every app's Worker config.
 */
export const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: true, persist: true, head_sampling_rate: 1 },
};

/**
 * Compare the Cloudflare resource IDs an ensure-resources run found/created
 * against the env's committed entry in envs.ts. On mismatch, print the exact
 * snippet to paste and exit 1 — IDs live in git, so bring-up always ends in
 * a reviewed commit.
 */
export function reconcileResources(
  envName: string,
  expected: Record<string, string>,
  actual: Record<string, string>,
): void {
  const drifted = Object.entries(actual).some(([key, id]) => expected[key] !== id);
  if (drifted) {
    console.log(`\nenvs.ts is out of date for ${envName} — update its resources entry to:\n`);
    console.log(`  resources: ${JSON.stringify(actual, null, 2).replaceAll("\n", "\n  ")},\n`);
    console.log("then commit (the Worker config reads it from envs.ts)");
    process.exit(1);
  }
  console.log(`✅ ${envName} resources all present and match envs.ts`);
}
