// src/repo/processor.test.ts — the RepoProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (stream/test-support.ts `reduceProcessor`). The saga — `itx.repos.create`
// landing the request, the processor provisioning and landing the certificate on `/` and on the
// path — is pinned end to end in e2e/repos.e2e.test.ts; the path → Artifacts-name mapping lives with
// the physical root (context/repos.test.ts).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { RepoProcessor } from "./processor.ts";
import type { RepoState } from "./contract.ts";

/** The reduce never reaches the context; the saga is the e2e's. */
const processor = () =>
  new RepoProcessor(() => Promise.reject(new Error("the reduce reaches no itx")));

const requested = { type: "events.iterate.com/repo/create-requested", payload: {} };
const created = { type: "events.iterate.com/repo/created", payload: { path: "/repos/config" } };
const failed = { type: "events.iterate.com/repo/create-failed", payload: { error: "boom" } };
const committed = {
  type: "events.iterate.com/repo/commit-completed",
  payload: { commitOid: "a", message: "m", changedPaths: ["worker.ts"] },
};

describe("RepoProcessor — the reduce", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; state: RepoState }[] =
    [
      { name: "the empty state", events: [], state: { creation: null } },
      {
        name: "a request opens the creation, at its offset",
        events: [requested],
        state: { creation: { status: "requested", offset: 1 } },
      },
      {
        name: "the certificate completes it, at its offset",
        events: [requested, created],
        state: { creation: { status: "created", offset: 2 } },
      },
      {
        name: "a failure closes the attempt at its offset (the error is on that event, not in state)",
        events: [requested, failed],
        state: { creation: { status: "failed", offset: 2 } },
      },
      {
        name: "a request after a failure is a new attempt",
        events: [requested, failed, requested],
        state: { creation: { status: "requested", offset: 3 } },
      },
      {
        name: "born once: a request after the certificate is a harmless fact",
        events: [requested, created, requested],
        state: { creation: { status: "created", offset: 2 } },
      },
      {
        name: "a failure after the certificate is a harmless fact too: the entity stays created",
        events: [requested, created, failed],
        state: { creation: { status: "created", offset: 2 } },
      },
      {
        name: "a commit fact (not consumed) and an unrelated event leave the state as it was",
        events: [requested, created, committed, { type: "note" }],
        state: { creation: { status: "created", offset: 2 } },
      },
      {
        name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
        events: [requested, { type: "events.iterate.com/repo/created", payload: { path: 1 } }],
        state: { creation: { status: "requested", offset: 1 } },
      },
    ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(processor(), events)).toEqual(state));
});
