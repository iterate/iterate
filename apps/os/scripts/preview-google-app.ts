// scripts/preview-google-app.ts — the Google client every per-PR preview names as iterate's own
// (preview-config.ts sets it as APP_CONFIG `integrations.google`), in a module of its own so the e2e
// that connects through it imports no deploy tooling.
import { dummyPetshopEnvs } from "../../../envs.ts";

/** A PREVIEW'S GOOGLE CLIENT — APP_CONFIG `integrations.google` for every per-PR preview: the pet
 *  shop's Google fake (apps/dummy-petshop/src/google.ts), which serves every Google path at its
 *  deployed origin (`googleOrigin`), and its seeded OAuth client. Fake credentials for a fake service,
 *  so they live here in code like the test-link switch; a preview can never reach a real Google
 *  account through iterate's client, and prd's client is Doppler's. */
export const PREVIEW_GOOGLE_APP = {
  oauthClientId: "petshop-default",
  oauthClientSecret: "petshop-default-secret",
  googleOrigin: dummyPetshopEnvs.prd!.baseUrl,
};
