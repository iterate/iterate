// src/control-plane/contract.ts — the sign-in providers and their names. The control-plane
// database (catalog.ts) is a normal Durable Object, not a stream processor: it keeps no event log
// and emits no record, so there is no contract here beyond the identity providers a linked account
// is known by.
import { z } from "zod";

/** The sign-in providers that prove who someone is (identity.ts): each names a person by a stable
 *  subject; a person links at most ONE subject per provider. */
export const IdentityProvider = z.enum(["google", "cloudflare", "github"]);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

/** Each provider's name as a person reads it. */
export const IDENTITY_PROVIDER_NAMES = {
  google: "Google",
  cloudflare: "Cloudflare",
  github: "GitHub",
} satisfies Record<IdentityProvider, string>;
