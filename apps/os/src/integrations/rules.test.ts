// src/integrations/rules.test.ts — rules.ts as rows. The response codes themselves run through the
// worker routes in __workers-tests__/integrations.test.ts.
import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { verifySecretHmac } from "../secrets.ts";
import {
  consentAccountRefusal,
  fakeProviderEmailRefusal,
  githubInstallationIdOf,
  githubInstallationRefusal,
  githubSignatureValid,
  grantedScopesOf,
  lendVerdict,
  missingScopes,
  signInAuthorizeParams,
  signInNeedsConsent,
  slackPayloadOf,
  slackSignatureValid,
  slackTeamIdOf,
} from "./rules.ts";

const KEY = "signing-secret";
const NOW = 1_800_000_000;

test.for([
  { row: "signed now", timestamp: String(NOW), signature: slackSigned("{}"), valid: true },
  {
    row: "5 minutes ago",
    timestamp: String(NOW - 300),
    signature: slackSigned("{}", NOW - 300),
    valid: true,
  },
  {
    row: "stale by a second",
    timestamp: String(NOW - 301),
    signature: slackSigned("{}", NOW - 301),
    valid: false,
  },
  {
    row: "from the future",
    timestamp: String(NOW + 301),
    signature: slackSigned("{}", NOW + 301),
    valid: false,
  },
  {
    row: "another key",
    timestamp: String(NOW),
    signature: slackSigned("{}", NOW, "other"),
    valid: false,
  },
  { row: "another body", timestamp: String(NOW), signature: slackSigned('{"a":1}'), valid: false },
  {
    row: "no v0= scheme",
    timestamp: String(NOW),
    signature: slackSigned("{}").slice(3),
    valid: false,
  },
  { row: "no signature", timestamp: String(NOW), signature: null, valid: false },
  { row: "no timestamp", timestamp: null, signature: slackSigned("{}"), valid: false },
  {
    row: "a timestamp that is not a number",
    timestamp: "soon",
    signature: slackSigned("{}", "soon"),
    valid: false,
  },
])("Slack signature: $row ⇒ $valid", async ({ timestamp, signature, valid }) => {
  expect(
    await slackSignatureValid({
      rawBody: "{}",
      timestamp,
      signature,
      nowSeconds: NOW,
      hmacHexMatches,
    }),
  ).toBe(valid);
});

test.for([
  { row: "Events API", payload: { team_id: "T1" }, teamId: "T1" },
  { row: "interactivity", payload: { team: { id: "T2" } }, teamId: "T2" },
  { row: "a shared channel's event", payload: { event: { team: "T3" } }, teamId: "T3" },
  { row: "team_id first", payload: { team_id: "T1", team: { id: "T2" } }, teamId: "T1" },
  { row: "none", payload: { event: {} }, teamId: null },
  { row: "blank", payload: { team_id: "" }, teamId: null },
])("Slack team: $row ⇒ $teamId", ({ payload, teamId }) => {
  expect(slackTeamIdOf(payload)).toBe(teamId);
});

test.for([
  {
    row: "Events API JSON",
    rawBody: '{"type":"event_callback"}',
    interactivity: false,
    payload: { type: "event_callback" },
  },
  {
    row: "interactivity's payload field",
    rawBody: `payload=${encodeURIComponent('{"type":"block_actions"}')}`,
    interactivity: true,
    payload: { type: "block_actions" },
  },
  { row: "not JSON", rawBody: "nope", interactivity: false, payload: null },
  { row: "a JSON array", rawBody: "[]", interactivity: false, payload: null },
])("Slack body: $row", ({ rawBody, interactivity, payload }) => {
  expect(slackPayloadOf(rawBody, interactivity)).toEqual(payload);
});

test.for([
  { row: "signed", signature: `sha256=${hex("{}")}`, valid: true },
  { row: "another key", signature: `sha256=${hex("{}", "other")}`, valid: false },
  { row: "no sha256= scheme", signature: hex("{}"), valid: false },
  { row: "none", signature: null, valid: false },
])("GitHub signature: $row ⇒ $valid", async ({ signature, valid }) => {
  expect(await githubSignatureValid({ rawBody: "{}", signature, hmacHexMatches })).toBe(valid);
});

test.for([
  { row: "a number", payload: { installation: { id: 42 } }, id: "42" },
  { row: "a string", payload: { installation: { id: "42" } }, id: "42" },
  { row: "an App-level ping", payload: { zen: "hi" }, id: null },
  { row: "blank", payload: { installation: { id: "" } }, id: null },
])("GitHub installation: $row ⇒ $id", ({ payload, id }) => {
  expect(githubInstallationIdOf(payload)).toBe(id);
});

// Who may connect an installation: the user (id 7) and what GitHub says of the installation's account.
const USER = { id: 7 };
const ORG = { id: 100, login: "acme", type: "Organization" };
test.for([
  {
    row: "installed on the user themself",
    account: { id: 7, login: "me", type: "User" },
    membership: null,
    refused: null,
  },
  {
    row: "installed on another user",
    account: { id: 8, login: "you", type: "User" },
    membership: null,
    refused: "installed on another user, you",
  },
  {
    row: "an organization the user is an active admin of",
    account: ORG,
    membership: { state: "active", role: "admin" },
    refused: null,
  },
  {
    row: "an organization the user is only a member of",
    account: ORG,
    membership: { state: "active", role: "member" },
    refused: "only an owner of acme",
  },
  {
    row: "an admin invitation not yet accepted",
    account: ORG,
    membership: { state: "pending", role: "admin" },
    refused: "only an owner of acme",
  },
  {
    row: "an organization the user reaches only as a collaborator",
    account: ORG,
    membership: null,
    refused: "only an owner of acme",
  },
  {
    row: "an installation the user cannot see",
    account: null,
    membership: null,
    refused: "cannot see this installation",
  },
])("GitHub installation proof: $row", ({ account, membership, refused }) => {
  const refusal = githubInstallationRefusal({ user: USER, account, membership });
  if (refused) expect(refusal).toContain(refused);
  else expect(refusal).toBeNull();
});

// SIGN-IN: what each provider is asked for, and when Google is asked again for its consent screen.
test.for([
  {
    row: "Google: offline, every granted scope included, the nonce",
    provider: "google",
    consentFor: undefined,
    params: {
      scope: "openid email profile https://www.googleapis.com/auth/gmail.modify",
      nonce: "n",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "select_account",
    },
    absent: ["login_hint"],
  },
  {
    row: "Google, bounced: the consent screen, for the address that answered",
    provider: "google",
    consentFor: "ada@example.com",
    params: {
      prompt: "select_account consent",
      login_hint: "ada@example.com",
      access_type: "offline",
    },
    absent: [],
  },
  {
    row: "Cloudflare: the scopes and the nonce, nothing Google-shaped",
    provider: "cloudflare",
    consentFor: undefined,
    params: {
      scope: "openid email profile https://www.googleapis.com/auth/gmail.modify",
      nonce: "n",
    },
    absent: ["access_type", "include_granted_scopes", "prompt"],
  },
  {
    row: "GitHub: no scope (the App's permissions are the grant), no nonce",
    provider: "github",
    consentFor: undefined,
    params: {
      client_id: "client",
      code_challenge_method: "S256",
      state: "s",
      prompt: "select_account",
    },
    absent: ["scope", "nonce", "access_type"],
  },
] as const)("sign-in authorize parameters — $row", ({ provider, consentFor, params, absent }) => {
  const built = signInAuthorizeParams(provider, {
    clientId: "client",
    redirectUri: "https://os.test/.auth/identity/callback",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
    state: "s",
    nonce: "n",
    codeChallenge: "c",
    consentFor,
  });
  expect(built).toMatchObject({
    ...params,
    redirect_uri: "https://os.test/.auth/identity/callback",
  });
  for (const key of absent) expect(built).not.toHaveProperty(key);
});

test.for([
  {
    row: "Google, no refresh token, no connection yet",
    provider: "google",
    refreshToken: false,
    connected: false,
    bounced: false,
    again: true,
  },
  {
    row: "Google, a refresh token came",
    provider: "google",
    refreshToken: true,
    connected: false,
    bounced: false,
    again: false,
  },
  {
    row: "Google, the connection keeps its stored refresh token",
    provider: "google",
    refreshToken: false,
    connected: true,
    bounced: false,
    again: false,
  },
  {
    row: "Google, asked once already (never a loop)",
    provider: "google",
    refreshToken: false,
    connected: false,
    bounced: true,
    again: false,
  },
  {
    row: "Cloudflare issues none without offline_access: no consent screen for it",
    provider: "cloudflare",
    refreshToken: false,
    connected: false,
    bounced: false,
    again: false,
  },
  {
    row: "GitHub",
    provider: "github",
    refreshToken: false,
    connected: false,
    bounced: false,
    again: false,
  },
] as const)("sign-in goes back for the consent screen — $row ⇒ $again", ({ again, ...input }) =>
  expect(signInNeedsConsent(input)).toBe(again),
);

test.for([
  {
    row: "under the test-link domain",
    email: "ada@preview.iterate.test",
    domain: "preview.iterate.test",
    refused: false,
  },
  {
    row: "its case aside",
    email: "Ada@Preview.Iterate.Test",
    domain: "preview.iterate.test",
    refused: false,
  },
  {
    row: "another domain",
    email: "ada@iterate.com",
    domain: "preview.iterate.test",
    refused: true,
  },
  {
    row: "a subdomain trick",
    email: "ada@evilpreview.iterate.test",
    domain: "preview.iterate.test",
    refused: true,
  },
  { row: "no test links (prd)", email: "ada@preview.iterate.test", domain: null, refused: true },
])("a fake provider signs in $row ⇒ refused: $refused", ({ email, domain, refused }) =>
  expect(fakeProviderEmailRefusal(email, domain) !== null).toBe(refused),
);

// INCREMENTAL CONSENT: the provider must answer for the account the connection holds.
test.for([
  { row: "Slack, the same team", data: { team: { id: "T1" } }, refused: false },
  { row: "Slack, another team", data: { team: { id: "T2" } }, refused: true },
  { row: "OpenID, the same sub", data: { id_token: idToken({ sub: "T1" }) }, refused: false },
  { row: "OpenID, another sub", data: { id_token: idToken({ sub: "42" }) }, refused: true },
  { row: "an answer naming no account", data: { access_token: "x" }, refused: true },
  { row: "a mangled ID token", data: { id_token: "not.a-jwt" }, refused: true },
])("an incremental consent for T1 — $row ⇒ refused: $refused", ({ data, refused }) =>
  expect(consentAccountRefusal("T1", data) !== null).toBe(refused),
);

// LENDS: live, to this borrower, and the lender still in its project; the instance's lend to every
// project answers each project that still borrows it, and the instance reaches every project.
test.for([
  {
    row: "live, to this project, lender a member",
    lend: { to: "prj_1", as: "/secrets/g" },
    borrower: "prj_1",
    borrowing: true,
    lender: { reachesBorrower: true },
    verdict: { as: "/secrets/g" },
  },
  {
    row: "revoked",
    lend: null,
    borrower: "prj_1",
    borrowing: true,
    lender: { reachesBorrower: true },
    verdict: { refused: "this lend was revoked" },
  },
  {
    row: "lent to another project",
    lend: { to: "prj_2", as: "/secrets/g" },
    borrower: "prj_1",
    borrowing: true,
    lender: { reachesBorrower: true },
    verdict: { refused: "this lend is to another project" },
  },
  {
    row: "the lender left the project",
    lend: { to: "prj_1", as: "/secrets/g" },
    borrower: "prj_1",
    borrowing: true,
    lender: { reachesBorrower: false },
    verdict: {
      refused: "the lender is no longer a member of this project",
      revoke: "membership-ended",
    },
  },
  {
    row: "the instance's lend to this project",
    lend: { to: "prj_1", as: "/secrets/openai" },
    borrower: "prj_1",
    borrowing: true,
    lender: "instance",
    verdict: { as: "/secrets/openai" },
  },
  {
    row: "the instance's lend to another project",
    lend: { to: "prj_2", as: "/secrets/openai" },
    borrower: "prj_1",
    borrowing: true,
    lender: "instance",
    verdict: { refused: "this lend is to another project" },
  },
  {
    row: "the instance's lend to every project, borrowed here",
    lend: { to: "every-project", as: "/secrets/openai" },
    borrower: "prj_1",
    borrowing: true,
    lender: "instance",
    verdict: { as: "/secrets/openai" },
  },
  {
    row: "the instance's lend to every project, returned by this project",
    lend: { to: "every-project", as: "/secrets/openai" },
    borrower: "prj_1",
    borrowing: false,
    lender: "instance",
    verdict: { refused: "this project no longer borrows this lend" },
  },
  {
    row: "the instance's lend to every project, revoked",
    lend: null,
    borrower: "prj_1",
    borrowing: true,
    lender: "instance",
    verdict: { refused: "this lend was revoked" },
  },
] as const)("a lend's use — $row", ({ lend, borrower, borrowing, lender, verdict }) =>
  expect(lendVerdict({ lend, borrower, borrowing, lender })).toEqual(verdict),
);

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
    row: "nothing asked (GitHub, Waitrose)",
    provider: "github",
    granted: [],
    asked: [],
    missing: [],
  },
] as const)("a person's account for a project — $row", ({ provider, granted, asked, missing }) =>
  expect(missingScopes(provider, granted, asked)).toEqual(missing),
);

// WHAT A CONSENT GRANTED: the token response's own `scope`, never what was asked, unless it names none.
test.for([
  {
    row: "Google, Gmail unticked",
    response: { access_token: "x", scope: "openid https://www.googleapis.com/auth/userinfo.email" },
    asked: "openid email https://www.googleapis.com/auth/gmail.modify",
    granted: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
  },
  {
    row: "comma-separated",
    response: { access_token: "x", scope: "chat:write,users:read" },
    asked: "chat:write",
    granted: ["chat:write", "users:read"],
  },
  {
    row: "no scope in the answer: exactly what was asked",
    response: { access_token: "x" },
    asked: "openid user-details.read",
    granted: ["openid", "user-details.read"],
  },
  { row: "no answer at all", response: null, asked: "", granted: [] },
] as const)("the scopes a consent granted — $row", ({ response, asked, granted }) =>
  expect(grantedScopesOf(response, asked)).toEqual(granted),
);

function hmacHexMatches(payload: string, signature: string) {
  return verifySecretHmac(KEY, { payload, signature });
}
function hex(payload: string, key = KEY) {
  return createHmac("sha256", key).update(payload).digest("hex");
}
function slackSigned(body: string, at: number | string = NOW, key = KEY) {
  return `v0=${hex(`v0:${at}:${body}`, key)}`;
}

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}
