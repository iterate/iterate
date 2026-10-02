// scripts/preview-cloudflare-app.ts — the Cloudflare client every per-PR preview names as iterate's
// own (generate-wrangler-config.ts sets it as APP_CONFIG `integrations.cloudflare`), in a module of its own so
// the e2e that signs in through it imports no deploy tooling.

/** A PREVIEW'S CLOUDFLARE CLIENT — APP_CONFIG `integrations.cloudflare` for every per-PR preview:
 *  the pet shop's Cloudflare fake (internal-packages/dummy-petshop/src/cloudflare.ts), its issuer under
 *  `<origin>/cloudflare` and its API at the origin (`cloudflareOrigin`, the deployment's
 *  `petshopOrigin`: generate-wrangler-config.ts), and its seeded OAuth
 *  client. Fake credentials for a fake service; a preview never reaches a real Cloudflare account
 *  through iterate's client, and prd's client is Doppler's. */
export const PREVIEW_CLOUDFLARE_APP = {
  oauthClientId: "petshop-default",
  oauthClientSecret: "petshop-default-secret",
};
