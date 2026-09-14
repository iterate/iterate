// src/workspace/processor.test.ts — the WorkspaceProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped). The saga
// itself is pinned once, on the shared driver, in src/repo/processor.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { WorkspaceProcessor } from "./processor.ts";
import { type WorkspaceView } from "./contract.ts";

const noEffects = { crossPost: async () => undefined };
const initial: WorkspaceView = { path: null, creation: null, attempts: 0, error: null, mounts: {} };
const configured = (mounts: Record<string, { repo: string } | null>) => ({
  type: "events.iterate.com/workspace/configured",
  payload: { mounts },
});

describe("WorkspaceProcessor — the saga's slice, and configured mounts folded from patches", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    view: WorkspaceView;
  }[] = [
    { name: "the empty view: no request, no configured mounts", events: [], view: initial },
    {
      name: "the saga: a request, then the certificate",
      events: [
        {
          type: "events.iterate.com/workspace/create-requested",
          payload: { path: "/workspaces/x" },
        },
        { type: "events.iterate.com/workspace/created", payload: { path: "/workspaces/x" } },
      ],
      view: { ...initial, path: "/workspaces/x", creation: "created", attempts: 1 },
    },
    {
      name: "a patch adds a mount at a path — the value is the repo's path",
      events: [configured({ "/vendor/cfg": { repo: "/repos/config" } })],
      view: { ...initial, mounts: { "/vendor/cfg": { repo: "/repos/config" } } },
    },
    {
      name: "a later patch replaces one path and leaves the others; null removes a mount",
      events: [
        configured({ "/a": { repo: "/one" }, "/b": { repo: "/two" } }),
        configured({ "/a": { repo: "/three" } }),
        configured({ "/b": null }),
      ],
      view: { ...initial, mounts: { "/a": { repo: "/three" } } },
    },
    {
      name: "removing a mount that was never configured is a no-op; an unrelated event leaves the view as it was",
      events: [configured({ "/never": null }), { type: "note", payload: { n: 1 } }],
      view: initial,
    },
    {
      name: "a malformed payload for the KNOWN type is skipped by the contract, never reduced",
      events: [
        {
          type: "events.iterate.com/workspace/configured",
          payload: { mounts: { "/x": { repo: 1 } } },
        },
        configured({ "/y": { repo: "/ok" } }),
      ],
      view: { ...initial, mounts: { "/y": { repo: "/ok" } } },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () =>
      expect(reduceProcessor(new WorkspaceProcessor(noEffects), events)).toEqual(view),
    );
});
