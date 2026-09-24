// src/secret/processor.test.ts — the SecretProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (stream/test-support.ts `reduceProcessor`). The verbs — `itx.secrets.set`
// landing the fact on the path and on the owner's root, the value in the facet, egress substituting
// it — are pinned end to end in e2e/secrets.e2e.test.ts and e2e/secrets-connections.e2e.test.ts.

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { SecretProcessor } from "./processor.ts";
import type { SecretState } from "./contract.ts";

const set = {
  type: "events.iterate.com/secret/set",
  payload: { path: "/secrets/shop", urls: ["https://shop.example"] },
};
const setWithRefresh = {
  type: "events.iterate.com/secret/set",
  payload: {
    path: "/secrets/shop",
    urls: ["https://shop.example"],
    refresh: "oauth-refresh-token",
  },
};
const deleted = { type: "events.iterate.com/secret/deleted", payload: { path: "/secrets/shop" } };
const used = {
  type: "events.iterate.com/secret/used",
  payload: { method: "GET", url: "https://shop.example/pets", status: 200 },
};
const refreshed = {
  type: "events.iterate.com/secret/refreshed",
  payload: { kind: "oauth-refresh-token", ok: true },
};

const rows: {
  name: string;
  events: { type: string; payload?: unknown }[];
  state: SecretState;
}[] = [
  { name: "the empty state", events: [], state: { material: null, deletion: null } },
  {
    name: "a set puts material there, at its offset",
    events: [set],
    state: { material: { offset: 1 }, deletion: null },
  },
  {
    name: "a second set is the latest write (a rotation, a strategy added)",
    events: [set, setWithRefresh],
    state: { material: { offset: 2 }, deletion: null },
  },
  {
    name: "a deletion empties it, at its offset",
    events: [set, deleted],
    state: { material: null, deletion: { offset: 2 } },
  },
  {
    name: "re-settable: a set after the deletion brings the secret back and clears the deletion",
    events: [set, deleted, set],
    state: { material: { offset: 3 }, deletion: null },
  },
  {
    name: "dies once: a second deletion after the certificate is a harmless fact",
    events: [set, deleted, deleted],
    state: { material: null, deletion: { offset: 2 } },
  },
  {
    name: "the use and refresh facts (not consumed) and an unrelated event leave the state as it was",
    events: [set, used, refreshed, { type: "note" }],
    state: { material: { offset: 1 }, deletion: null },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [set, { type: "events.iterate.com/secret/set", payload: { path: 1, urls: [] } }],
    state: { material: { offset: 1 }, deletion: null },
  },
];
for (const { name, events, state } of rows)
  test(`SecretProcessor — the reduce: ${name}`, () =>
    expect(reduceProcessor(new SecretProcessor(), events)).toEqual(state));
