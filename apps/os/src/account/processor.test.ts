// src/account/processor.test.ts — the AccountProcessor's executable spec, declarative `{ events →
// state }` rows on the shared processor harness (iterate/stream/test-support `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped).

import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { AccountProcessor } from "./processor.ts";
import { type AccountState } from "./contract.ts";

/** Every fact the account folds is the platform's: stamped `source.platform` as its one writer
 *  stamps it (session.ts `appendPlatformFacts`). */
const platform = { origin: "/", platform: true } as const;
const authenticated = (operationId: string, credential: "from-server-cookie" | "admin-secret") => ({
  type: "events.iterate.com/account/authenticated",
  payload: { credential, at: 1, operationId },
  source: platform,
});

/** A personal access token's record as grants.ts `mint` lands it: `hash` is the key's SHA-256. */
const minted = (id: string, name: string, expiresAt: number | null) => ({
  type: "events.iterate.com/account/personal-access-token-minted",
  payload: {
    id,
    name,
    hash: "a".repeat(64),
    email: "me@example.com",
    projects: ["prj_1"],
    expiresAt,
    mintedBy: "grant_cli",
  },
});
const key = (name: string, expiresAt: number | null, endedAt: string | null) => ({
  name,
  hash: "a".repeat(64),
  email: "me@example.com",
  projects: ["prj_1"],
  expiresAt,
  mintedBy: "grant_cli",
  mintedAt: expect.any(String),
  endedAt,
});

const rows: {
  name: string;
  events: { type: string; payload?: unknown; source?: typeof platform }[];
  state: AccountState;
}[] = [
  {
    name: "the empty state",
    events: [],
    state: {
      authentications: [],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "an authentication fact appends to authentications (no credential material, only the fact)",
    events: [authenticated("op-1", "admin-secret")],
    state: {
      authentications: [{ credential: "admin-secret", at: 1, operationId: "op-1" }],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "a key minted, a grant ended, a consent approved: each a fact where it happened — the key's record closes when it ends; a stranger's end is recorded too; a second mint or end is ignored; a record with no hash is no key",
    events: [
      { ...minted("pat_a", "laptop", 9), source: platform },
      { ...minted("pat_a", "again", 1), source: platform },
      {
        type: "events.iterate.com/account/grant-ended",
        payload: { grantId: "pat_b" },
        source: platform,
      },
      {
        type: "events.iterate.com/account/grant-ended",
        payload: { grantId: "pat_a" },
        source: platform,
      },
      {
        type: "events.iterate.com/account/grant-ended",
        payload: { grantId: "pat_a" },
        source: platform,
      },
      // an end already under the id: the key is born closed
      { ...minted("pat_b", "phone", null), source: platform },
      // malformed: skipped by the engine's contract validation, never a key
      {
        type: "events.iterate.com/account/personal-access-token-minted",
        payload: { id: "pat_c", name: "no hash", projects: ["prj_1"], expiresAt: null },
        source: platform,
      },
      {
        type: "events.iterate.com/account/consent-approved",
        payload: {
          clientId: "c1",
          clientName: "Claude Code",
          projects: null,
          scopes: ["iterate"],
        },
        source: platform,
      },
    ],
    state: {
      authentications: [],
      secrets: {},
      integrations: {},
      personalAccessTokens: {
        pat_a: key("laptop", 9, expect.any(String)),
        pat_b: key("phone", null, expect.any(String)),
      },
      endedGrants: { pat_b: { at: expect.any(String) }, pat_a: { at: expect.any(String) } },
      grantUses: {},
      memberships: {},
      endedMemberships: {},
      consents: [
        {
          clientId: "c1",
          clientName: "Claude Code",
          projects: null,
          scopes: ["iterate"],
          at: expect.any(String),
        },
      ],
    },
  },
  {
    name: "a membership is a row by organization with the role and the first membership's time (the control-plane saga lands it here beside the organization's log); a new role replaces it; removed drops it; a grant's use only moves forward",
    events: [
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_me", role: "member" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_me", role: "owner" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_2", userId: "user_me", role: "member" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId: "org_2", userId: "user_me" },
        source: platform,
      },
      {
        type: "events.iterate.com/account/grant-used",
        payload: { grantId: "grant_a", at: 5 },
        source: platform,
      },
      {
        type: "events.iterate.com/account/grant-used",
        payload: { grantId: "grant_a", at: 3 },
        source: platform,
      },
    ],
    state: {
      authentications: [],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: { grant_a: { at: 5 } },
      consents: [],
      memberships: { org_1: { role: "owner", since: new Date(1000).toISOString() } },
      endedMemberships: { org_2: { at: expect.any(String) } },
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "a MINT — an organization's first membership, landed in the background after the creation that minted it answered — never overrides a membership the account holds, nor revives one that ended, however late it lands; a removal's end is kept even for a membership never held, and joining again clears it",
    events: [
      // a demotion that landed before the mint: the mint is older, the account keeps the demotion
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_me", role: "member" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_me", role: "owner", mint: true },
        source: platform,
      },
      // a removal that landed before the mint: the membership stays ended
      {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId: "org_2", userId: "user_me" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_2", userId: "user_me", role: "owner", mint: true },
        source: platform,
      },
      // a mint first, as it lands almost always
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_3", userId: "user_me", role: "owner", mint: true },
        source: platform,
      },
      // joining the ended one again, by invitation
      {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId: "org_4", userId: "user_me" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_4", userId: "user_me", role: "member" },
        source: platform,
      },
    ],
    state: {
      authentications: [],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {
        org_1: { role: "member", since: expect.any(String) },
        org_3: { role: "owner", since: expect.any(String) },
        org_4: { role: "member", since: expect.any(String) },
      },
      endedMemberships: { org_2: { at: expect.any(String) } },
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "facts fold in order; an unrelated event leaves the state as it was",
    events: [
      authenticated("op-1", "from-server-cookie"),
      { type: "note", payload: { n: 1 } },
      authenticated("op-2", "admin-secret"),
    ],
    state: {
      authentications: [
        { credential: "from-server-cookie", at: 1, operationId: "op-1" },
        { credential: "admin-secret", at: 1, operationId: "op-2" },
      ],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential: "not-a-kind" },
        source: platform,
      },
      authenticated("op-2", "from-server-cookie"),
    ],
    state: {
      authentications: [{ credential: "from-server-cookie", at: 1, operationId: "op-2" }],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "a fact the platform did not write — the person appended it to their own context, a claimed `source.platform` stripped at the append — is folded by nothing",
    events: [
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential: "admin-secret", at: 1, operationId: "forged" },
      },
      minted("pat_f", "forged", null),
      {
        type: "events.iterate.com/secret/set",
        payload: { path: "/secrets/forged", urls: ["https://evil.example.test"] },
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_forged", userId: "user_me", role: "owner" },
      },
      authenticated("op-1", "from-server-cookie"),
      // the platform's mint of a real key, then an end the person appended: the key stays open
      { ...minted("pat_a", "laptop", 9), source: platform },
      { type: "events.iterate.com/account/grant-ended", payload: { grantId: "pat_a" } },
      { type: "events.iterate.com/account/grant-used", payload: { grantId: "pat_a", at: 7 } },
    ],
    state: {
      authentications: [{ credential: "from-server-cookie", at: 1, operationId: "op-1" }],
      personalAccessTokens: { pat_a: key("laptop", 9, null) },
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {},
      integrations: {},
    },
  },
  {
    name: "a sign-in's connection is the person's row, a disconnect drops it; the secret it keeps lists its lends until each is revoked; a person's own appends of either change nothing",
    events: [
      {
        type: "events.iterate.com/secret/set",
        payload: {
          path: "/secrets/google-42",
          urls: ["https://google.test"],
          refresh: "oauth-refresh-token",
        },
        source: platform,
      },
      {
        type: "events.iterate.com/google/connected",
        payload: {
          connection: "42",
          client: "iterate",
          account: "ada@example.com",
          externalId: "42",
          scopes: ["openid"],
        },
        source: platform,
      },
      {
        type: "events.iterate.com/github/connected",
        payload: { connection: "7", client: "iterate", account: "ada", externalId: "7" },
        source: platform,
      },
      {
        type: "events.iterate.com/github/disconnected",
        payload: { connection: "7" },
        source: platform,
      },
      {
        type: "events.iterate.com/cloudflare/connected",
        payload: { connection: "evil", client: "iterate", account: "x", externalId: "x" },
      },
      lent("lend_a", "prj_1"),
      lent("lend_b", "prj_2"),
      {
        type: "events.iterate.com/secret/lend-revoked",
        payload: { path: "/secrets/google-42", lendId: "lend_a", reason: "membership-ended" },
        source: platform,
      },
    ],
    state: {
      authentications: [],
      personalAccessTokens: {},
      endedGrants: {},
      grantUses: {},
      consents: [],
      memberships: {},
      endedMemberships: {},
      secrets: {
        "/secrets/google-42": {
          urls: ["https://google.test"],
          refresh: "oauth-refresh-token",
          createdAt: expect.any(String),
          lends: { lend_b: { to: "prj_2", as: "/secrets/google-ada", since: expect.any(String) } },
        },
      },
      integrations: {
        "/integrations/google/42": {
          provider: "google",
          connection: "42",
          client: "iterate",
          account: "ada@example.com",
          externalId: "42",
          scopes: ["openid"],
        },
      },
    },
  },
];
for (const { name, events, state } of rows)
  test(`AccountProcessor — the account state folded from facts: ${name}`, () =>
    expect(reduceProcessor(new AccountProcessor(), events)).toEqual(state));

function lent(lendId: string, to: string) {
  return {
    type: "events.iterate.com/secret/lent",
    payload: { path: "/secrets/google-42", lendId, to, as: "/secrets/google-ada" },
    source: platform,
  };
}
