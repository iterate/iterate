import { test } from "vitest";

// Quarantined with tasks/quarantined-cloudflare-artifacts-event-delivery.md:
// the old implementation synchronously created an account-level Cloudflare
// subscription per repo, coupling every otherwise-isolated project bootstrap
// to one rate-limited control plane. Restore this only behind a scalable
// delivery boundary that is not reconciled per project.
test.skip("an external Artifact push emits repository commit and task facts", () => {
  throw new Error("Quarantined until scalable Artifact event delivery exists.");
});
