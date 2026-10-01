import { expect, test, vi } from "vitest";
import { installAgents } from "./install.ts";

test("installAgents enables the catalog processor on the root, then writes the itx.agents rule to it", async () => {
  const root = fakeRoot();
  await installAgents(root);
  expect(root).toMatchObject({
    calls: [
      [
        "processors.enable",
        "agents",
        {
          ...published("AgentCollectionDurableObject"),
          consumes: ["events.iterate.com/agent/created", "events.iterate.com/agent/deleted"],
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: {
            match: "itx.agents",
            target: ["itx", "facets", ["get", "agents", published("AgentCollectionDurableObject")]],
            description: expect.stringContaining("create(path)"),
          },
        },
      ],
    ],
  });
});

/** The facet spec every row and rule of the app names: a class of the config repo's `agents.ts`,
 *  in the project's published config (the facet restarts by that module's bundle, not a key). */
function published(className: string) {
  return { className, mainModule: "agents.ts", source: ["itx", ["cd", "/"], "config"] };
}

/** A project root that records the calls installing makes. */
function fakeRoot() {
  const calls: unknown[][] = [];
  return {
    calls,
    processors: {
      enable: vi.fn(async (name: string, spec?: object) => {
        calls.push(["processors.enable", name, spec]);
        return { name };
      }),
    },
    append: vi.fn(async (...events: object[]) => {
      calls.push(["append", ...events]);
      return [];
    }),
  };
}
