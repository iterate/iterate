// src/account/contract.test.ts — the AccountProcessor's executable spec, declarative `{ events →
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
const tokenCreate = (requestId: string, name: string) => ({
  type: "events.iterate.com/account/token-create-requested",
  payload: { requestId, name, value: `secret-${requestId}`, requestedAt: 1 },
});
const tokenRevoke = (requestId: string) => ({
  type: "events.iterate.com/account/token-revoked",
  payload: { requestId },
});

describe("AccountProcessor — the account view folded from facts + commands", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: AccountView }[] =
    [
      { name: "the empty view", events: [], view: { authentications: [], tokens: [] } },
      {
        name: "an authentication fact appends to authentications (no credential material, only the fact)",
        events: [authenticated("op-1", "admin-secret")],
        view: {
          authentications: [{ credential: "admin-secret", at: 1, operationId: "op-1" }],
          tokens: [],
        },
      },
      {
        name: "token-create adds by requestId; token-revoke drops exactly that one, the rest stand",
        events: [tokenCreate("a", "CI"), tokenCreate("b", "laptop"), tokenRevoke("a")],
        view: {
          authentications: [],
          tokens: [{ requestId: "b", name: "laptop", value: "secret-b", requestedAt: 1 }],
        },
      },
      {
        name: "revoking a requestId that was never created is a no-op",
        events: [tokenCreate("a", "CI"), tokenRevoke("nope")],
        view: {
          authentications: [],
          tokens: [{ requestId: "a", name: "CI", value: "secret-a", requestedAt: 1 }],
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
          tokens: [],
        },
      },
    ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new AccountProcessor(), events)).toEqual(view));
});
