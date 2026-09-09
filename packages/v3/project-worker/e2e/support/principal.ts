// principal.ts — mint project tokens for the worker under test. The local e2e worker's secret is the
// one worker-config.ts sets; a deployed worker's is a wrangler secret, handed to the run as
// PROJECT_TOKEN_SECRET (never in the tree).
import { signClaims, type ProjectTokenClaims } from "../../src/principal.ts";
import { projectHostsAreLocal } from "./project-host.ts";
import { E2E_PROJECT_TOKEN_SECRET } from "./worker-config.ts";

function projectTokenSecret(): string {
  if (projectHostsAreLocal()) return E2E_PROJECT_TOKEN_SECRET;
  const secret = process.env.PROJECT_TOKEN_SECRET;
  if (!secret)
    throw new Error(
      "PROJECT_TOKEN_SECRET unset — the deployed worker's APP_CONFIG_PROJECT_TOKEN_SECRET, needed to mint tokens against it",
    );
  return secret;
}

/** A token for `projectId`, good for a minute. */
export const mintProjectToken = (
  claims: Omit<ProjectTokenClaims, "expiresAt"> & { expiresAt?: number },
): Promise<string> =>
  signClaims(
    { expiresAt: Date.now() + 60_000, ...claims } satisfies ProjectTokenClaims,
    projectTokenSecret(),
  );
