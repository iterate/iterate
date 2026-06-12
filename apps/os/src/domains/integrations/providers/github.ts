// GitHub as an IntegrationDefinition. Webhook ingress keyed by installation
// id; itx.integrations.github.octokit IS @octokit/rest, authenticated from the
// project's `github/access-token` Secret.

import { Octokit } from "@octokit/rest";
import { verify as verifyGithubSignature } from "@octokit/webhooks-methods";
import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";

export const GITHUB_ACCESS_TOKEN_SECRET_NAME = "access-token";

export const githubIntegration: IntegrationDefinition = {
  slug: "github",
  displayName: "GitHub",
  instructions:
    "GitHub for this project. itx.integrations.github.octokit is a ready-authenticated " +
    "@octokit/rest client — e.g. itx.integrations.github.octokit.rest.issues.create({ owner, repo, title }). " +
    "Inbound GitHub webhooks land on this project's /integrations/github stream.",

  // The partial fetch function: GitHub webhooks, verified and captured.
  async fetch({ request, config, capture }) {
    if (new URL(request.url).pathname !== "/api/integrations/github/webhook") return null;

    const github = config.integrations.github;
    if (!github) {
      return Response.json({ error: "GitHub webhook ingress is not configured." }, { status: 503 });
    }

    const bodyText = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const valid =
      signature != null &&
      (await verifyGithubSignature(
        github.webhookSigningSecret.exposeSecret(),
        bodyText,
        signature,
      ).catch(() => false));
    if (!valid) {
      return Response.json({ error: "Invalid GitHub webhook signature." }, { status: 401 });
    }

    const body = JSON.parse(bodyText) as { installation?: { id?: number | string } };
    const installationId = body.installation?.id;
    await capture({
      transport: "webhook",
      routingKey: installationId == null ? null : `installation:${installationId}`,
      idempotencyKey: request.headers.get("x-github-delivery"),
      body,
    });
    return Response.json({ ok: true });
  },

  providedSecrets: [
    {
      name: GITHUB_ACCESS_TOKEN_SECRET_NAME,
      description:
        "GitHub token used by itx.integrations.github (app installation token or PAT). " +
        "Installation tokens expire hourly; the secret's derivation loop owns rotation.",
    },
  ],

  async createSdk(ctx) {
    // The "token" is a getSecret placeholder; ctx.fetch (the terminal egress
    // pipe) substitutes it on the way out. Octokit never holds material.
    return {
      octokit: new Octokit({
        auth: ctx.secretRef(GITHUB_ACCESS_TOKEN_SECRET_NAME),
        request: { fetch: ctx.fetch },
      }),
    };
  },
};
