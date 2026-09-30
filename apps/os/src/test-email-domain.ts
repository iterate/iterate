// test-email-domain.ts — pure, so scripts that run before a build (the Vite config's
// scripts/generate-wrangler-config.ts) and the specs import it as they are.

/** The reserved domain test people live under — a per-PR preview's `pr<N>@preview.iterate.test`
 *  (scripts/os/preview.ts), local dev's `test@…` (scripts/getin.ts), the specs' fresh ones — and a
 *  preview's and local dev's `login.testEmailDomain` (app-config.ts). `.test` is RFC 6761's: nothing ever mails
 *  it. */
export const TEST_EMAIL_DOMAIN = "preview.iterate.test";
