// session.test.ts — the account append's await-vs-best-effort split: a grant's end awaits
// `appendAccountFacts` (the revocation truth: a failed append must fail the verb); every other fact
// goes through `publishAccountFact`, best-effort in waitUntil.

import { expect, test } from "vitest";
import { appendAccountFacts, publishAccountFact } from "./session.ts";

const fact = { type: "events.iterate.com/account/test", payload: {} };

test("appendAccountFacts enables the account processor, then appends stamped platform — and a failed append rejects", async () => {
  const { namespace, calls } = failingAppendNamespace();
  await expect(appendAccountFacts(namespace, "u1", fact, { principal: null })).rejects.toThrow(
    "append refused",
  );
  expect(calls).toEqual([
    [["itx", "processors", ["enable", "account"]], [], { principal: null }],
    [["itx", "builtins", ["append", fact]], [], { principal: null, platform: true }],
  ]);
});

test("publishAccountFact hands waitUntil a promise that resolves even when the append fails", async () => {
  const { namespace } = failingAppendNamespace();
  const pending: Promise<unknown>[] = [];
  publishAccountFact(
    { contextNamespace: namespace, waitUntil: (promise) => void pending.push(promise) },
    "u1",
    fact,
    { principal: null },
  );
  expect(pending).toHaveLength(1);
  await expect(pending[0]).resolves.toBeUndefined();
});

/** A context namespace whose append (the second `invoke`, after the processor enable) rejects. */
function failingAppendNamespace() {
  const calls: unknown[][] = [];
  const context = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 2) throw new Error("append refused");
    },
  };
  const namespace = { getByName: () => context } as unknown as Parameters<
    typeof appendAccountFacts
  >[0];
  return { namespace, calls };
}
