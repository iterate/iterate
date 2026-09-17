import { z } from "zod";

/** The platform's OAuth scopes — what an app may ask for and what a consent grants:
 *   - `iterate`             — reach the projects the person grants (every app; implied, always granted)
 *   - `account`             — manage the person's sessions and personal access tokens
 *   - `organizations:write` — the person's organizations: list every one they belong to, create new ones
 *  Consent is task-based (the shape Cloudflare's own OAuth consent took in August 2026: a client
 *  requests a set, the person may deselect the optional ones, the token carries what was granted):
 *  `iterate` is required, every other requested scope is optional on the consent page, and an app
 *  reads the granted set from `session.info().scopes` rather than assuming its request. */
export const OAuthScope = z.enum(["iterate", "account", "organizations:write"]);
export type OAuthScope = z.infer<typeof OAuthScope>;

export const OAuthScopes = z
  .array(OAuthScope)
  .transform((scopes) => [...new Set(["iterate", ...scopes])]);
