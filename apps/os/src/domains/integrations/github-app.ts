// GitHub App installation-token minting for trusted first-party Durable Object
// code: the Secret DO's refresh strategy, the Repo DO's GitHub mirror push,
// and first-party config-template downloads. The App private key comes from
// deployment config and never reaches a caller.

import { z } from "zod";
import { computeSignatureBase64Url } from "../secrets/utils.ts";
import { fetchWithCredentialRedirects } from "../secrets/credential-fetch.ts";
import type { PlatformCredsRef } from "../secrets/types.ts";
import { lookupConnectionClaim } from "./integration-streams.ts";

const GithubRepositoryInstallation = z.object({
  id: z.number().int().positive(),
});

const GithubInstallationAccessToken = z.object({
  token: z.string().trim().min(1),
});

type GithubAppFetcher = (request: Request) => Promise<Response>;

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
  fetcher?: GithubAppFetcher;
  installationId: string;
  privateKeyPem: string;
}): Promise<string> {
  const appJwt = await createGithubAppJwt(input);
  const response = await fetchWithCredentialRedirects(
    new Request(
      `${input.apiBase.replace(/\/$/, "")}/app/installations/${input.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt}`,
          "user-agent": "iterate-os",
        },
      },
    ),
    input.fetcher === undefined ? {} : { fetcher: input.fetcher },
  );
  if (!response.ok) {
    throw new Error(`github installation token mint failed: HTTP ${response.status}`);
  }
  const parsed = GithubInstallationAccessToken.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("github installation token mint returned an invalid response", {
      cause: parsed.error,
    });
  }
  return parsed.data.token;
}

/** Resolve the App installation that owns one repository, then mint a
 * short-lived token for it. This is for platform-owned repositories where the
 * installation is deployment authority, not a user/project connection claim. */
export async function mintGithubRepositoryInstallationToken(input: {
  apiBase: string;
  appId: string;
  fetcher?: GithubAppFetcher;
  owner: string;
  privateKeyPem: string;
  repo: string;
}): Promise<string> {
  const apiBase = input.apiBase.replace(/\/$/, "");
  const appJwt = await createGithubAppJwt(input);
  const repository = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const response = await fetchWithCredentialRedirects(
    new Request(`${apiBase}/repos/${repository}/installation`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "user-agent": "iterate-os",
      },
    }),
    input.fetcher === undefined ? {} : { fetcher: input.fetcher },
  );
  if (!response.ok) {
    throw new Error(
      `github repository installation lookup failed for ${input.owner}/${input.repo}: HTTP ${response.status}`,
    );
  }
  const parsed = GithubRepositoryInstallation.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("github repository installation lookup returned an invalid response", {
      cause: parsed.error,
    });
  }
  return await mintGithubInstallationToken({
    apiBase,
    appId: input.appId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    installationId: String(parsed.data.id),
    privateKeyPem: input.privateKeyPem,
  });
}

async function createGithubAppJwt(input: {
  appId: string;
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
  return `${signingInput}.${signature}`;
}
