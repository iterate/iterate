// src/account/processor.test.ts — the AccountProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped). apps/os
// tests its processors the same shape.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AccountProcessor } from "./processor.ts";
import { type AccountView } from "./contract.ts";

const authenticated = (operationId: string, credential: "from-server-cookie" | "admin-secret") => ({
  type: "events.iterate.com/account/authenticated",
  payload: { credential, at: 1, operationId },
});

describe("AccountProcessor — the account view folded from facts", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: AccountView }[] =
    [
      {
        name: "the empty view",
        events: [],
        view: { authentications: [], personalAccessTokens: {}, endedGrants: {}, consents: [] },
      },
      {
        name: "an authentication fact appends to authentications (no credential material, only the fact)",
        events: [authenticated("op-1", "admin-secret")],
        view: {
          authentications: [{ credential: "admin-secret", at: 1, operationId: "op-1" }],
          personalAccessTokens: {},
          endedGrants: {},
          consents: [],
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
        view: {
          authentications: [],
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
        name: "facts fold in order; an unrelated event leaves the view as it was",
        events: [
          authenticated("op-1", "from-server-cookie"),
          { type: "note", payload: { n: 1 } },
          authenticated("op-2", "admin-secret"),
        ],
        view: {
          authentications: [
            { credential: "from-server-cookie", at: 1, operationId: "op-1" },
            { credential: "admin-secret", at: 1, operationId: "op-2" },
          ],
          personalAccessTokens: {},
          endedGrants: {},
          consents: [],
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
        view: {
          authentications: [{ credential: "from-server-cookie", at: 1, operationId: "op-2" }],
          personalAccessTokens: {},
          endedGrants: {},
          consents: [],
        },
      },
    ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new AccountProcessor(), events)).toEqual(view));
});
