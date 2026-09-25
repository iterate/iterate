import { z } from "zod";

/** The platform's OAuth scopes — what an app may ask for and what a consent grants:
 *   - `iterate`             — reach the projects the person grants (every app; implied, always granted)
 *   - `account`             — manage the person's sessions and personal access tokens
 *   - `organizations:write` — the person's organizations: list every one they belong to, create new ones
 *   - `admin`               — operate the platform: every project and person. Granted only to an
 *                             email the deployment's `admins` lists (apps/os consent.ts), and only
 *                             while it lists it (oauth.ts). Signing a client in as someone else is
 *                             no scope: the issuer offers it to a listed admin at consent
 *  Consent is task-based (the shape Cloudflare's own OAuth consent took in August 2026: a client
 *  requests a set, the person may deselect the optional ones, the token carries what was granted):
 *  `iterate` is required, every other requested scope is optional on the consent page, and an app
 *  reads the granted set from `session.info().scopes` rather than assuming its request. */
export const OAuthScope = z.enum(["iterate", "account", "organizations:write", "admin"]);
export type OAuthScope = z.infer<typeof OAuthScope>;

export const OAuthScopes = z
  .array(OAuthScope)
  .transform((scopes) => [...new Set(["iterate", ...scopes])]);

/** A requested scope as the consent page shows it: its name, what it means to the person, and
 *  whether they may untick it (`iterate` never). */
export interface ConsentScope {
  name: OAuthScope;
  title: string;
  note: string;
  required: boolean;
}

/** What each scope means to the person — the consent page's copy, sent with `consent.describe` so
 *  the page renders what it is given: a scope added to `OAuthScope` is described here or it does
 *  not compile. */
export const OAuthScopeDescriptions: Record<OAuthScope, Omit<ConsentScope, "name">> = {
  iterate: {
    title: "Read and make changes in the projects you grant it",
    note: "Required — what the app is for.",
    required: true,
  },
  account: {
    title: "See and end your sessions, and mint personal access tokens",
    note: "Optional.",
    required: false,
  },
  "organizations:write": {
    title: "See all your organizations and create new ones",
    note: "Optional.",
    required: false,
  },
  admin: {
    title: "Operate this platform: every project and every person",
    note: "Optional. For platform admins; ends 12 hours after you allow it.",
    required: false,
  },
};
