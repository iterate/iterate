// src/project/processor.test.ts — the ProjectProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { ProjectProcessor } from "./processor.ts";
import { type ProjectView } from "./contract.ts";

const repoBorn = (name: string) => ({
  type: "events.iterate.com/repos/created",
  payload: { name, path: `/repos/${name}` },
});
const workspaceBorn = (path: string) => ({
  type: "events.iterate.com/workspace/created",
  payload: { path },
});

describe("ProjectProcessor — the catalog folded from cross-posted birth certificates", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: ProjectView }[] =
    [
      { name: "the empty catalog", events: [], view: { repos: {}, workspaces: {} } },
      {
        name: "a repo's and a workspace's certificates each add one entry, stamped with the event's time",
        events: [repoBorn("config"), workspaceBorn("/workspaces/notes")],
        view: {
          repos: { config: { path: "/repos/config", createdAt: expect.any(String) } },
          workspaces: { "/workspaces/notes": { createdAt: expect.any(String) } },
        },
      },
      {
        name: "a second certificate for the same name is ignored (born once); an unrelated event leaves the view as it was",
        events: [repoBorn("config"), repoBorn("config"), { type: "note" }, repoBorn("lib")],
        view: {
          repos: {
            config: { path: "/repos/config", createdAt: expect.any(String) },
            lib: { path: "/repos/lib", createdAt: expect.any(String) },
          },
          workspaces: {},
        },
      },
      {
        name: "a malformed certificate is skipped by the contract, never reduced",
        events: [
          { type: "events.iterate.com/repos/created", payload: { name: 1 } },
          workspaceBorn("/w"),
        ],
        view: { repos: {}, workspaces: { "/w": { createdAt: expect.any(String) } } },
      },
    ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new ProjectProcessor(), events)).toEqual(view));
});
