// src/instance/processor.test.ts — the InstanceProcessor's executable spec: `{ events → state }` rows
// on the shared processor harness (iterate/stream/test-support `reduceProcessor`). Every certificate
// the instance folds is the platform's cross-post (context/built-ins.ts), stamped `source.platform`.
import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { InstanceProcessor } from "./processor.ts";

test.for([
  {
    row: "a secret set and lent to every project is a row with its lend",
    events: [setFact(), lentFact()],
    secrets: catalog(standingLend()),
  },
  {
    row: "one project returning the lend leaves it standing for the rest",
    events: [setFact(), lentFact(), revokedFact({ reason: "borrower-deleted", borrower: "prj_1" })],
    secrets: catalog(standingLend()),
  },
  {
    row: "the operator's revocation ends it",
    events: [setFact(), lentFact(), revokedFact({ reason: "lender" })],
    secrets: catalog({}),
  },
  {
    row: "a certificate the platform did not cross-post changes nothing",
    events: [setFact(), { ...lentFact(), source: {} }],
    secrets: catalog(undefined),
  },
])("the instance's catalog — $row", ({ events, secrets }) =>
  expect(reduceProcessor(new InstanceProcessor(), events)).toEqual({ secrets }),
);

function setFact() {
  return {
    type: "events.iterate.com/secret/set",
    payload: { path: "/secrets/openai", urls: ["https://api.openai.com"] },
    source: { platform: true as const },
  };
}

function lentFact() {
  return {
    type: "events.iterate.com/secret/lent",
    payload: {
      path: "/secrets/openai",
      lendId: "lend_1",
      to: "every-project",
      as: "/secrets/openai",
    },
    source: { platform: true as const },
  };
}

function revokedFact(payload: Record<string, unknown>) {
  return {
    type: "events.iterate.com/secret/lend-revoked",
    payload: { path: "/secrets/openai", lendId: "lend_1", ...payload },
    source: { platform: true as const },
  };
}

function standingLend() {
  return { lend_1: { to: "every-project", as: "/secrets/openai", since: expect.any(String) } };
}

/** The instance's catalog of `/secrets/openai` (toEqual reads an undefined `lends` as absent). */
function catalog(lends: Record<string, unknown> | undefined) {
  return {
    "/secrets/openai": { urls: ["https://api.openai.com"], createdAt: expect.any(String), lends },
  };
}
