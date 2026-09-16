// src/repo/processor.test.ts — the RepoProcessor's executable spec: the reduce as declarative
// `{ events → view }` rows (stream/test-support.ts `reduceProcessor`). The path → Artifacts-name
// mapping lives with the physical root (context/repos.test.ts). The creation itself — `create()` landing the facts — is pinned end to end in
// e2e/repos.e2e.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { RepoProcessor } from "./processor.ts";
import type { RepoView } from "./contract.ts";

const identity = { path: "/repos/config" };
const requested = { type: "events.iterate.com/repos/create-requested", payload: identity };
const created = { type: "events.iterate.com/repos/created", payload: identity };
const failed = {
  type: "events.iterate.com/repos/create-failed",
  payload: { ...identity, error: "boom" },
};
const committed = {
  type: "events.iterate.com/repo/commit-completed",
  payload: { commitOid: "a", message: "m", changedPaths: ["worker.ts"] },
};
const initial: RepoView = { path: null, creation: null, error: null };

describe("RepoProcessor — the reduce", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: RepoView }[] = [
    { name: "the empty view", events: [], view: initial },
    {
      name: "a request opens the creation",
      events: [requested],
      view: { path: "/repos/config", creation: "requested", error: null },
    },
    {
      name: "the certificate completes it",
      events: [requested, created],
      view: { path: "/repos/config", creation: "created", error: null },
    },
    {
      name: "a failure closes the attempt with its error",
      events: [requested, failed],
      view: { path: "/repos/config", creation: "failed", error: "boom" },
    },
    {
      name: "a request after a failure is a new attempt and clears the error",
      events: [requested, failed, requested],
      view: { path: "/repos/config", creation: "requested", error: null },
    },
    {
      name: "a commit fact (not consumed) and an unrelated event leave the view as it was",
      events: [requested, created, committed, { type: "note" }],
      view: { path: "/repos/config", creation: "created", error: null },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        { type: "events.iterate.com/repos/create-requested", payload: { path: 1 } },
        created,
      ],
      view: { path: null, creation: "created", error: null },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new RepoProcessor(), events)).toEqual(view));
});
