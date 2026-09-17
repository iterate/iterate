// src/workspace/processor.test.ts — the WorkspaceProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`). The
// creation itself — `create()` landing the facts — is pinned end to end in e2e/workspaces.e2e.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { WorkspaceProcessor } from "./processor.ts";
import { type WorkspaceView } from "./contract.ts";

const identity = { path: "/workspaces/x" };
const requested = { type: "events.iterate.com/workspace/create-requested", payload: identity };
const created = { type: "events.iterate.com/workspace/created", payload: identity };
const initial: WorkspaceView = { path: null, creation: null };

describe("WorkspaceProcessor — the reduce", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    view: WorkspaceView;
  }[] = [
    { name: "the empty view", events: [], view: initial },
    {
      name: "a request opens the creation",
      events: [requested],
      view: { path: "/workspaces/x", creation: "requested" },
    },
    {
      name: "the certificate completes it; an unrelated event leaves the view as it was",
      events: [requested, created, { type: "note", payload: { n: 1 } }],
      view: { path: "/workspaces/x", creation: "created" },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        { type: "events.iterate.com/workspace/create-requested", payload: { path: 1 } },
        created,
      ],
      view: { path: null, creation: "created" },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new WorkspaceProcessor(), events)).toEqual(view));
});
