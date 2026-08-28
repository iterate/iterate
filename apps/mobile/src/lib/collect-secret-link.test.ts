import { expect, test } from "vitest";
import { parseCollectSecretLink } from "./collect-secret-link.ts";

// The URLs here are the exact shape apps/os/src/lib/collect-secret-link.ts
// mints. specs/mobile/collect-secret.spec.ts drives a link built by that
// builder end to end, so the two encodings cannot drift apart silently.

test("reads everything the collection page would have shown", () => {
  expect(
    parseCollectSecretLink(
      'https://os.iterate.com/collect-secret/acme?path=/secrets/integrations/stripe/api-key&egress=["https://api.stripe.com"]&description="Stripe%20restricted%20key"&notify=/agents/mobile/2026',
    ),
  ).toEqual({
    description: "Stripe restricted key",
    egress: ["https://api.stripe.com"],
    notify: "/agents/mobile/2026",
    path: "/secrets/integrations/stripe/api-key",
    projectSlug: "acme",
  });
});

test("a link with no agent to tell, and no note, is still usable", () => {
  expect(
    parseCollectSecretLink(
      'https://os.iterate.com/collect-secret/acme?path=/secrets/k&egress=["https://api.stripe.com"]',
    ),
  ).toMatchObject({ description: undefined, notify: undefined, path: "/secrets/k" });
});

test("free text that looks like a number survives, because it rides as JSON", () => {
  // The reason `description` is JSON-encoded at the other end: raw "12345"
  // would come back a number and take the whole link down.
  expect(
    parseCollectSecretLink(
      'https://os.iterate.com/collect-secret/acme?path=/secrets/k&egress=["https://x.com"]&description="12345"',
    ),
  ).toMatchObject({ description: "12345" });
});

test("a link that does not describe a usable secret is refused", () => {
  const usable =
    'https://os.iterate.com/collect-secret/acme?path=/secrets/k&egress=["https://x.com"]';
  // Truncated or rewritten links — chat clients mangle long URLs.
  expect(parseCollectSecretLink(usable.replace("path=/secrets/k&", ""))).toBeNull();
  expect(parseCollectSecretLink(usable.replace('egress=["https://x.com"]', ""))).toBeNull();
  // A pin to nothing can never be used, so it is not a usable request.
  expect(parseCollectSecretLink(usable.replace('["https://x.com"]', "[]"))).toBeNull();
  // Paths that address something other than a secret, or an agent that isn't one.
  expect(parseCollectSecretLink(usable.replace("/secrets/k", "/agents/k"))).toBeNull();
  expect(parseCollectSecretLink(`${usable}&notify=/secrets/not-an-agent`)).toBeNull();
  // Not a collection link at all.
  expect(parseCollectSecretLink("https://os.iterate.com/projects/acme")).toBeNull();
  expect(parseCollectSecretLink("not a url")).toBeNull();
});
