// THE ITERATE GITHUB APP'S INSTALLATION TOKEN, narrowed to the repositories and permissions a job
// needs. The App is the platform's own, installed on every repository in the org; its id and key
// live in prd's configuration (Doppler os/prd's APP_CONFIG `integrations.github`). The flake
// dashboard writes issues in this repository with one (./flake-dashboard/update.ts), and the
// Copybara copies push to their repositories with another (./copybara.ts). A token lasts an hour.
import { createSign } from "node:crypto";
import { z } from "zod";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { getEnv, OS_DOPPLER_PROJECT, osEnvs } from "../../envs.ts";
import { resolveEnvContext } from "../lib/env-context.ts";

/** The iterate App's id and private key, from prd's configuration. */
export async function iterateAppFromPrd() {
  const prd = await resolveEnvContext(getEnv("prd", osEnvs), {
    dopplerProject: OS_DOPPLER_PROJECT,
  });
  const app = parseAppConfig({
    APP_CONFIG: prd.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: prd.secrets.APP_CONFIG_SECRETS__KEY,
  }).integrations.github;
  if (!app) throw new Error("prd's APP_CONFIG has no integrations.github, the iterate App");
  return { appId: app.appId, privateKey: app.privateKey.exposeSecret() };
}

/** An installation token of the App, for `repositories` alone, with `permissions` alone. */
export async function iterateAppToken(input: {
  appId: string;
  privateKey: string;
  owner: string;
  repositories: string[];
  permissions: Record<string, "read" | "write">;
}) {
  const now = Math.floor(Date.now() / 1000);
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // GitHub App JWT: RS256, issued a minute back for clock drift, valid for less than ten minutes.
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iat: now - 60,
    exp: now + 540,
    iss: input.appId,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(input.privateKey, "base64url");
  const github = async (path: string, body?: object) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${unsigned}.${signature}`,
        "x-github-api-version": "2022-11-28",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const installation = z
    .object({ id: z.number() })
    .parse(await github(`/orgs/${input.owner}/installation`));
  const access = z
    .object({
      token: z.string().min(1),
      permissions: z.record(z.string(), z.string()),
      repositories: z.array(z.object({ name: z.string() })),
    })
    .parse(
      await github(`/app/installations/${installation.id}/access_tokens`, {
        repositories: input.repositories,
        permissions: input.permissions,
      }),
    );
  return {
    token: access.token,
    permissions: access.permissions,
    repositories: access.repositories.map(({ name }) => name),
  };
}
