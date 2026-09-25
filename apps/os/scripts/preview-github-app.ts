// scripts/preview-github-app.ts — the GitHub App every per-PR preview names as iterate's own
// (preview-config.ts sets it as APP_CONFIG `integrations.github`), in a module of its own so the e2e
// that installs it imports no deploy tooling.
import { dummyPetshopEnvs } from "../../../envs.ts";

/** A PREVIEW'S GITHUB APP — APP_CONFIG `integrations.github` for every per-PR preview, but its key:
 *  the pet shop's GitHub fake (apps/dummy-petshop/src/github.ts), which serves github.com's and
 *  api.github.com's paths at its deployed origin (`githubOrigin`), and its seeded OAuth client. Fake
 *  credentials for a fake service, so they live here in code like the test-link switch; the App's
 *  private key is a throwaway generated for this fake alone and kept in Doppler `os/preview`
 *  (`previewGithubAppPrivateKey`) — no key is ever in git. A preview can never reach a real GitHub
 *  installation through iterate's App, and prd's App is Doppler's `os/prd`. */
export const PREVIEW_GITHUB_APP = {
  appId: "iterate-preview",
  appSlug: "iterate-preview",
  oauthClientId: "petshop-default",
  oauthClientSecret: "petshop-default-secret",
  webhookSecret: "preview-github-webhook-secret",
  githubOrigin: dummyPetshopEnvs.prd!.baseUrl,
};

/** The throwaway App key (PEM) from the environment — Doppler `os/preview`
 *  `PREVIEW_GITHUB_APP_PRIVATE_KEY`, which the preview deploy and the e2e both run under. Refused
 *  loudly when unset: a preview whose App cannot sign would fail every GitHub connect. */
export function previewGithubAppPrivateKey(): string {
  const privateKey = process.env.PREVIEW_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!privateKey)
    throw new Error(
      "PREVIEW_GITHUB_APP_PRIVATE_KEY is unset — run under `doppler run --project os --config preview`",
    );
  return privateKey;
}
