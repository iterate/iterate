// src/repo/processor.test.ts — the RepoProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (stream/test-support.ts `reduceProcessor`). The sagas — `itx.repos.create`
// landing the request, the processor provisioning and landing the certificate on `/` and on the
// path; `itx.repos.delete` the same in reverse — are pinned end to end in e2e/repos.e2e.test.ts; the
// path → Artifacts-name mapping lives with the physical root (context/cf-artifacts.test.ts).

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { RepoProcessor } from "./processor.ts";
import type { RepoState } from "./contract.ts";

/** The reduce never reaches the context; the saga is the e2e's. */
const processor = () =>
  new RepoProcessor(() => Promise.reject(new Error("the reduce reaches no itx")));

const requested = { type: "events.iterate.com/repo/create-requested", payload: {} };
const created = { type: "events.iterate.com/repo/created", payload: { path: "/repos/config" } };
const failed = { type: "events.iterate.com/repo/create-failed", payload: { error: "boom" } };
const deleteRequested = { type: "events.iterate.com/repo/delete-requested", payload: {} };
const deleted = { type: "events.iterate.com/repo/deleted", payload: { path: "/repos/config" } };
const committed = {
  type: "events.iterate.com/repo/commit-completed",
  payload: { path: "/repos/config", commitOid: "a", message: "m", changedPaths: ["worker.ts"] },
};

const rows: { name: string; events: { type: string; payload?: unknown }[]; state: RepoState }[] = [
  { name: "the empty state", events: [], state: { creation: null, deletion: null } },
  {
    name: "a request opens the creation, at its offset",
    events: [requested],
    state: { creation: { status: "requested", offset: 1 }, deletion: null },
  },
  {
    name: "the certificate completes it, at its offset",
    events: [requested, created],
    state: { creation: { status: "created", offset: 2 }, deletion: null },
  },
  {
    name: "a failure closes the attempt at its offset (the error is on that event, not in state)",
    events: [requested, failed],
    state: { creation: { status: "failed", offset: 2 }, deletion: null },
  },
  {
    name: "a request after a failure is a new attempt",
    events: [requested, failed, requested],
    state: { creation: { status: "requested", offset: 3 }, deletion: null },
  },
  {
    name: "born once: a request after the certificate is a harmless fact",
    events: [requested, created, requested],
    state: { creation: { status: "created", offset: 2 }, deletion: null },
  },
  {
    name: "a failure after the certificate is a harmless fact too: the entity stays created",
    events: [requested, created, failed],
    state: { creation: { status: "created", offset: 2 }, deletion: null },
  },
  {
    name: "a commit fact (not consumed) and an unrelated event leave the state as it was",
    events: [requested, created, committed, { type: "note" }],
    state: { creation: { status: "created", offset: 2 }, deletion: null },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [requested, { type: "events.iterate.com/repo/created", payload: { path: 1 } }],
    state: { creation: { status: "requested", offset: 1 }, deletion: null },
  },
  {
    name: "a delete request opens the deletion at its offset; creation is untouched",
    events: [requested, created, deleteRequested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "requested", offset: 3 },
    },
  },
  {
    name: "the death certificate completes it, at its offset; creation is still untouched",
    events: [requested, created, deleteRequested, deleted],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "dies once: a second delete request after the certificate is a harmless fact",
    events: [requested, created, deleteRequested, deleted, deleteRequested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "not re-creatable: a create request after the death certificate is a harmless fact",
    events: [requested, created, deleteRequested, deleted, requested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
];
for (const { name, events, state } of rows)
  test(`RepoProcessor — the reduce: ${name}`, () =>
    expect(reduceProcessor(processor(), events)).toEqual(state));
