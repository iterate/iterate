// src/account/processor.test.ts — the AccountProcessor's executable spec, declarative `{ events →
// state }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped). apps/os
// tests its processors the same shape.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AccountProcessor } from "./processor.ts";
import { type AccountState } from "./contract.ts";

const authenticated = (operationId: string, credential: "from-server-cookie" | "admin-secret") => ({
  type: "events.iterate.com/account/authenticated",
  payload: { credential, at: 1, operationId },
});

describe("AccountProcessor — the account state folded from facts", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
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
        secrets: {},
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
        secrets: {},
      },
    },
    {
      name: "a token minted, a grant ended, a consent approved: each a fact where it happened — the token's row closes when its grant ends; a stranger's end is recorded too; a second mint or end is ignored",
      events: [
        {
          type: "events.iterate.com/account/grant-minted",
          payload: { grantId: "grant_a", name: "laptop", projects: ["prj_1"], expiresAt: 9 },
        },
        {
          type: "events.iterate.com/account/grant-minted",
          payload: { grantId: "grant_a", name: "again", projects: [], expiresAt: 1 },
        },
        { type: "events.iterate.com/account/grant-ended", payload: { grantId: "grant_b" } },
        { type: "events.iterate.com/account/grant-ended", payload: { grantId: "grant_a" } },
        { type: "events.iterate.com/account/grant-ended", payload: { grantId: "grant_a" } },
        // the end landed before the mint (both are published after the fact): born closed
        {
          type: "events.iterate.com/account/grant-minted",
          payload: { grantId: "grant_b", name: "phone", projects: [], expiresAt: 5 },
        },
        {
          type: "events.iterate.com/account/consent-approved",
          payload: {
            clientId: "c1",
            clientName: "Claude Code",
            projects: null,
            scopes: ["iterate"],
          },
        },
      ],
      state: {
        authentications: [],
        secrets: {},
        personalAccessTokens: {
          grant_a: {
            name: "laptop",
            projects: ["prj_1"],
            expiresAt: 9,
            mintedAt: expect.any(String),
            endedAt: expect.any(String),
          },
          grant_b: {
            name: "phone",
            projects: [],
            expiresAt: 5,
            mintedAt: expect.any(String),
            endedAt: expect.any(String),
          },
        },
        endedGrants: { grant_b: { at: expect.any(String) }, grant_a: { at: expect.any(String) } },
        grantUses: {},
        memberships: {},
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
        },
        {
          type: "events.iterate.com/organization/member-added",
          payload: { orgId: "org_1", userId: "user_me", role: "owner" },
        },
        {
          type: "events.iterate.com/organization/member-added",
          payload: { orgId: "org_2", userId: "user_me", role: "member" },
        },
        {
          type: "events.iterate.com/organization/member-removed",
          payload: { orgId: "org_2", userId: "user_me" },
        },
        { type: "events.iterate.com/account/grant-used", payload: { grantId: "grant_a", at: 5 } },
        { type: "events.iterate.com/account/grant-used", payload: { grantId: "grant_a", at: 3 } },
      ],
      state: {
        authentications: [],
        personalAccessTokens: {},
        endedGrants: {},
        grantUses: { grant_a: { at: 5 } },
        consents: [],
        memberships: { org_1: { role: "owner", since: new Date(1000).toISOString() } },
        secrets: {},
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
        secrets: {},
      },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        {
          type: "events.iterate.com/account/authenticated",
          payload: { credential: "not-a-kind" },
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
        secrets: {},
      },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(new AccountProcessor(), events)).toEqual(state));
});
