// src/workspace/processor.test.ts — the WorkspaceProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`): the pure
// reduce only, with the engine's contract validation (a malformed KNOWN payload is skipped).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { WorkspaceProcessor } from "./processor.ts";
import { type WorkspaceView } from "./contract.ts";

const configured = (mounts: Record<string, { repo: string } | null>) => ({
  type: "events.iterate.com/workspace/configured",
  payload: { mounts },
});

describe("WorkspaceProcessor — born, and configured mounts folded from patches", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    view: WorkspaceView;
  }[] = [
    {
      name: "the empty view: not born, no configured mounts",
      events: [],
      view: { created: false, mounts: {} },
    },
    {
      name: "the birth certificate",
      events: [
        { type: "events.iterate.com/workspace/created", payload: { path: "/workspaces/x" } },
      ],
      view: { created: true, mounts: {} },
    },
    {
      name: "a patch adds a mount at a path",
      events: [configured({ "/vendor/cfg": { repo: "config" } })],
      view: { created: false, mounts: { "/vendor/cfg": { repo: "config" } } },
    },
    {
      name: "a later patch replaces one path and leaves the others; null removes a mount",
      events: [
        configured({ "/a": { repo: "one" }, "/b": { repo: "two" } }),
        configured({ "/a": { repo: "three" } }),
        configured({ "/b": null }),
      ],
      view: { created: false, mounts: { "/a": { repo: "three" } } },
    },
    {
      name: "removing a mount that was never configured is a no-op; an unrelated event leaves the view as it was",
      events: [configured({ "/never": null }), { type: "note", payload: { n: 1 } }],
      view: { created: false, mounts: {} },
    },
    {
      name: "a malformed payload for the KNOWN type is skipped by the contract, never reduced",
      events: [
        {
          type: "events.iterate.com/workspace/configured",
          payload: { mounts: { "/x": { repo: 1 } } },
        },
        configured({ "/y": { repo: "ok" } }),
      ],
      view: { created: false, mounts: { "/y": { repo: "ok" } } },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new WorkspaceProcessor(), events)).toEqual(view));
});
