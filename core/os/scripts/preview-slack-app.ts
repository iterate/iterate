// scripts/preview-slack-app.ts — the Slack app every per-PR preview names as iterate's own
// (generate-wrangler-config.ts sets it as APP_CONFIG `integrations.slack`), in a module of its own so the e2e
// that signs webhooks with it imports no deploy tooling.

/** A PREVIEW'S SLACK APP — APP_CONFIG `integrations.slack` for every per-PR preview: the pet shop's
 *  Slack fake (internal-packages/dummy-petshop/src/slack.ts) at its deployed origin (`slackOrigin`, the deployment's
 *  `petshopOrigin`: generate-wrangler-config.ts), its seeded OAuth client, and a
 *  signing secret the e2e signs webhooks with (test/vitest/os/integrations.e2e.test.ts). Fake credentials
 *  for a fake service, so they live here in code like the admin issuer; a preview can never
 *  reach a real Slack workspace through iterate's app, and prd's app is Doppler's. */
export const PREVIEW_SLACK_APP = {
  oauthClientId: "petshop-default",
  oauthClientSecret: "petshop-default-secret",
  webhookSigningSecret: "preview-slack-signing-secret",
};
