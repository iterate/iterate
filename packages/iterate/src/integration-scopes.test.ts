// integration-scopes.test.ts — `missingScopes`, as rows.
import { expect, test } from "vitest";
import { missingScopes } from "./integration-scopes.ts";

// A PERSON'S ACCOUNT FOR A PROJECT: connected at once when it holds every scope asked, else the
// scopes it lacks are what Google or Cloudflare is asked to add.
test.for([
  {
    row: "a Google sign-in with Gmail, asked the project's default",
    provider: "google",
    granted: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
    asked: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    missing: [],
  },
  {
    row: "a Google sign-in with the identity alone",
    provider: "google",
    granted: ["openid", "email", "profile"],
    asked: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
    missing: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  {
    row: "a connection that recorded no scopes",
    provider: "google",
    granted: [],
    asked: ["openid", "openid"],
    missing: ["openid"],
  },
  {
    row: "Cloudflare, where email is not an alias",
    provider: "cloudflare",
    granted: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    asked: ["openid", "email"],
    missing: ["email"],
  },
  {
    row: "nothing asked (GitHub)",
    provider: "github",
    granted: [],
    asked: [],
    missing: [],
  },
] as const)("a person's account for a project — $row", ({ provider, granted, asked, missing }) =>
  expect(missingScopes(provider, granted, asked)).toEqual(missing),
);
