// GitHub App installation-token minting, shared by the two trusted callers:
// the Secret DO's `github-app-installation` refresh strategy (Octokit's REST
// transport) and the Repo DO's GitHub mirror push (git-over-HTTPS, where
// isomorphic-git needs the token as a Basic password and no placeholder
// substitution is possible). Both run in first-party Durable Object code; the
// App private key comes from deployment config and never reaches a caller.

import { computeSignatureBase64Url } from "../secrets/utils.ts";
import { fetchWithCredentialRedirects } from "../secrets/credential-fetch.ts";
import type { PlatformCredsRef } from "../secrets/types.ts";
import { lookupConnectionClaim } from "./integration-streams.ts";

/**
 * Platform App authority follows the deployment-wide integration claim. A
 * project-owned App key is independent of that directory because possessing
 * the key is the authority for its own installations.
 */
export async function assertGithubInstallationTokenMintAuthorized(input: {
  installationId: string;
  privateKey: PlatformCredsRef | "material";
  projectId: string;
}): Promise<void> {
  if (input.privateKey === "material") return;

  const claim = await lookupConnectionClaim("github", input.installationId);
  if (claim?.projectId !== input.projectId) {
    throw new Error(
      `GitHub installation ${input.installationId} is not claimed by project ${input.projectId}.`,
    );
  }
}

function base64UrlOfJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign an App JWT (RS256, iat 60s in the past per GitHub's clock-drift
 * guidance) and exchange it for an installation access token at
 * `/app/installations/{id}/access_tokens`. Tokens expire after one hour;
 * callers treat them as per-operation credentials, not stored material.
 */
export async function mintGithubInstallationToken(input: {
  apiBase: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${base64UrlOfJson({ alg: "RS256", typ: "JWT" })}.${base64UrlOfJson({
    iat: now - 60,
    exp: now + 540,
    iss: input.appId,
  })}`;
  const signature = await computeSignatureBase64Url({
    payload: signingInput,
    privateKeyPem: input.privateKeyPem,
  });
  const response = await fetchWithCredentialRedirects(
    new Request(
      `${input.apiBase.replace(/\/$/, "")}/app/installations/${input.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${signingInput}.${signature}`,
          "user-agent": "iterate-os",
        },
      },
    ),
  );
  if (!response.ok) {
    throw new Error(`github installation token mint failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { token?: string };
  if (typeof data.token !== "string") {
    throw new Error("github installation token mint returned no token");
  }
  return data.token;
}
