// src/workspace/processor.test.ts — the WorkspaceProcessor's executable spec: the reduce as
// declarative `{ events → state }` rows (stream/test-support.ts `reduceProcessor`). The saga —
// `itx.workspaces.create` landing the request, the processor landing the certificate on `/` and on
// the path — is pinned end to end in e2e/workspaces.e2e.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { WorkspaceProcessor } from "./processor.ts";
import type { WorkspaceState } from "./contract.ts";

/** The reduce never reaches the context; the saga is the e2e's. */
const processor = () =>
  new WorkspaceProcessor(() => Promise.reject(new Error("the reduce reaches no itx")));

const requested = { type: "events.iterate.com/workspace/create-requested", payload: {} };
const created = {
  type: "events.iterate.com/workspace/created",
  payload: { path: "/workspaces/x" },
};
const failed = { type: "events.iterate.com/workspace/create-failed", payload: { error: "boom" } };

describe("WorkspaceProcessor — the reduce", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    state: WorkspaceState;
  }[] = [
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
      name: "an unrelated event leaves the state as it was",
      events: [requested, created, { type: "note", payload: { n: 1 } }],
      state: { creation: { status: "created", offset: 2 } },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [requested, { type: "events.iterate.com/workspace/created", payload: { path: 1 } }],
      state: { creation: { status: "requested", offset: 1 } },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(processor(), events)).toEqual(state));
});
