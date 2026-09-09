// principal.ts — the credentials a test mints for the worker under test. PROJECT TOKENS are signed
// here with the lane's secret (the local e2e worker's is the one worker-config.ts sets; a deployed
// worker's is a wrangler secret, handed to the run as PROJECT_TOKEN_SECRET, never in the tree). A
// PROJECT API KEY is minted over the wire, through the real door.
import { signClaims, type ProjectTokenClaims } from "../../src/principal.ts";
import { adminCredentials, session } from "./client.ts";
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

/** The project's API key, minted fresh — `projects.get(project).rotateApiKey()` on the admin session
 *  (a previous key stops verifying). What a device presents: `authenticate({ type: "project-secret",
 *  project, secret })` over `/api`, or `Authorization: Bearer` on the project's host. */
export const mintProjectApiKey = (project: string): Promise<string> =>
  session().authenticate(adminCredentials()).projects.get(project).rotateApiKey();
