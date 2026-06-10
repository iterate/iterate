import { expect, it } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  getInitialProcessorState,
  runProcessorReduce,
} from "./stream-processors.ts";
import type { StreamEvent } from "./event.ts";

it("catch-all delivery tolerates transport-added envelope keys like streamPath", () => {
  const contract = defineProcessorContract({
    slug: "catch-all-counter",
    version: "0.0.0",
    description: "counts every delivered event",
    stateSchema: z.object({ count: z.number() }),
    initialState: { count: 0 },
    events: {},
    consumes: ["*"],
    emits: [],
    reduce: ({ state }) => ({ count: state.count + 1 }),
  });

  // The OS API serves events augmented with a top-level streamPath; a
  // catch-all processor must consume them without envelope errors.
  const served = {
    streamPath: "/agents/demo",
    type: "external/anything",
    payload: { hello: "world" },
    offset: 1,
    createdAt: new Date(0).toISOString(),
  } as unknown as StreamEvent;

  const reduction = runProcessorReduce({
    event: served,
    processor: { contract },
    state: getInitialProcessorState(contract),
  });

  expect(reduction).toMatchObject({ state: { count: 1 } });
});

it("catalog-declared events also tolerate transport-added envelope keys", () => {
  const contract = defineProcessorContract({
    slug: "catalog-counter",
    version: "0.0.0",
    description: "counts catalog-declared events",
    stateSchema: z.object({ count: z.number() }),
    initialState: { count: 0 },
    events: {
      "test/known": {
        description: "a known event",
        payloadSchema: z.object({}),
      },
    },
    consumes: ["test/known"],
    emits: [],
    reduce: ({ state }) => ({ count: state.count + 1 }),
  });

  const served = {
    streamPath: "/agents/demo",
    type: "test/known",
    payload: {},
    offset: 1,
    createdAt: new Date(0).toISOString(),
  } as unknown as StreamEvent;

  const reduction = runProcessorReduce({
    event: served,
    processor: { contract },
    state: getInitialProcessorState(contract),
  });

  expect(reduction).toMatchObject({ state: { count: 1 } });
});
