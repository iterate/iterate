import { z } from "zod";

/** A historical version, or one receiving only some traffic, cannot certify the fleet. */
export function servesRecordedWorkerVersion(input: unknown, version: string) {
  const { deployments } = Deployments.parse(input);
  // The API returns the active deployment first, followed by its history.
  const current = deployments[0];
  return Boolean(
    current &&
    current.versions.length === 1 &&
    current.versions[0].version_id === version &&
    current.versions[0].percentage === 100,
  );
}

// Cloudflare's List Worker Deployments result (also used by Wrangler).
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
const Deployments = z.object({
  deployments: z.array(
    z.object({
      versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })),
    }),
  ),
});
