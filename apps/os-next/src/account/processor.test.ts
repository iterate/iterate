// src/account/processor.test.ts — the AccountProcessor's executable spec, declarative `{ events →
// state }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped). apps/os
// tests its processors the same shape.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AccountProcessor } from "./processor.ts";
import type { AccountState } from "./contract.ts";

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
    { name: "the empty state", events: [], state: { authentications: [] } },
    {
      name: "an authentication fact appends to authentications (no credential material, only the fact)",
      events: [authenticated("op-1", "admin-secret")],
      state: { authentications: [{ credential: "admin-secret", at: 1, operationId: "op-1" }] },
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
      },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(new AccountProcessor(), events)).toEqual(state));
});
