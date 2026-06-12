// GitHub as an IntegrationDefinition. Webhook ingress keyed by installation
// id; itx.integrations.github.octokit IS @octokit/rest, authenticated from the
// project's `github/access-token` Secret.

import { Octokit } from "@octokit/rest";
import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { constantTimeEqual, hmacSha256Hex } from "~/domains/integrations/providers/verify.ts";

export const GITHUB_ACCESS_TOKEN_SECRET_NAME = "access-token";

export const githubIntegration: IntegrationDefinition = {
  slug: "github",
  displayName: "GitHub",
  instructions:
    "GitHub for this project. itx.integrations.github.octokit is a ready-authenticated " +
    "@octokit/rest client — e.g. itx.integrations.github.octokit.rest.issues.create({ owner, repo, title }). " +
    "Inbound GitHub webhooks land on this project's /integrations/github stream.",

  // The partial fetch function: GitHub webhooks, verified and captured.
  async fetch({ request, env, capture }) {
    if (new URL(request.url).pathname !== "/api/integrations/github/webhook") return null;

    const signingSecret = env.GITHUB_WEBHOOK_SECRET;
    if (!signingSecret) {
      return Response.json({ error: "GitHub webhook ingress is not configured." }, { status: 503 });
    }

    const bodyText = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const expected = `sha256=${await hmacSha256Hex({ secret: signingSecret, message: bodyText })}`;
    if (!signature || !constantTimeEqual(expected, signature)) {
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
        "Installation tokens expire hourly; the Secret DO's refresh loop owns rotation.",
      firstPartyEnvFallback: "APP_CONFIG_GITHUB_TOKEN",
    },
  ],

  async createSdk(ctx) {
    const auth = await ctx.getSecretMaterial(GITHUB_ACCESS_TOKEN_SECRET_NAME);
    return { octokit: new Octokit({ auth }) };
  },
};
