// catalog.test.ts — which birth and death certificates the agents catalog on `/` counts, as
// declarative `{ events → state }` rows on the shared harness (iterate/stream/test-support
// `reduceProcessor`, which stamps an input without an origin with the context it is on, as the
// stream does).

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AgentCatalogProcessor, type AgentCatalogState } from "./catalog.ts";

const path = "/agents/support";

test.for<{ name: string; events: ReturnType<typeof certificate>[]; state: AgentCatalogState }>([
  {
    name: "a birth stamped by the agent it names: counted",
    events: [certificate("created", path)],
    state: { agents: { [path]: { createdAt: new Date(1000).toISOString() } }, deleted: {} },
  },
  {
    name: "a birth stamped by another context: ignored",
    events: [certificate("created", "/agents/other")],
    state: { agents: {}, deleted: {} },
  },
  {
    name: "a birth appended with no stamp on `/`: stamped `/`, ignored",
    events: [certificate("created")],
    state: { agents: {}, deleted: {} },
  },
  {
    name: "a death stamped by the agent: dead, and terminal",
    events: [
      certificate("created", path),
      certificate("deleted", path),
      certificate("created", path),
    ],
    state: { agents: {}, deleted: { [path]: { deletedAt: new Date(2000).toISOString() } } },
  },
  {
    name: "a death stamped by another context: ignored, the agent lives",
    events: [certificate("created", path), certificate("deleted", "/agents/other")],
    state: { agents: { [path]: { createdAt: new Date(1000).toISOString() } }, deleted: {} },
  },
  {
    name: "a death appended with no stamp on `/`: stamped `/`, ignored",
    events: [certificate("created", path), certificate("deleted")],
    state: { agents: { [path]: { createdAt: new Date(1000).toISOString() } }, deleted: {} },
  },
])("the catalog: $name", ({ events, state }) => {
  expect(reduceProcessor(new AgentCatalogProcessor(), events)).toEqual(state);
});

/** `/agents/support`'s birth or death certificate, stamped `origin` when one is given. */
function certificate(kind: "created" | "deleted", origin?: string) {
  return {
    type: `events.iterate.com/agent/${kind}`,
    payload: { path },
    ...(origin && { source: { origin } }),
  };
}
