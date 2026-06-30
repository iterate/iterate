import { expect, it } from "vitest";
import { z } from "zod";
import {
  buildEvent,
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

it("buildEvent validates local and dependency event inputs", () => {
  const dependency = defineProcessorContract({
    slug: "build-event-dependency",
    version: "0.0.0",
    description: "owns dependency events",
    stateSchema: z.object({}),
    initialState: {},
    events: {
      "test/build-event/dependency": {
        payloadSchema: z.object({ accepted: z.boolean() }),
      },
    },
    consumes: ["test/build-event/dependency"],
    emits: [],
  });
  const contract = defineProcessorContract({
    slug: "build-event",
    version: "0.0.0",
    description: "owns local events and depends on another owner",
    stateSchema: z.object({}),
    initialState: {},
    processorDeps: [dependency],
    events: {
      "test/build-event/local": {
        payloadSchema: z.object({ count: z.number().int() }),
      },
    },
    consumes: ["test/build-event/local"],
    emits: ["test/build-event/dependency"],
  });

  expect(
    buildEvent({
      contract,
      event: { type: "test/build-event/local", payload: { count: 1 } },
    }),
  ).toEqual({ type: "test/build-event/local", payload: { count: 1 } });
  expect(
    buildEvent({
      contract,
      event: { type: "test/build-event/dependency", payload: { accepted: true } },
    }),
  ).toEqual({ type: "test/build-event/dependency", payload: { accepted: true } });
  expect(() =>
    buildEvent({
      contract,
      event: { type: "test/build-event/local", payload: { count: "1" } } as never,
    }),
  ).toThrow();
  expect(() =>
    buildEvent({
      contract,
      event: { type: "test/build-event/missing", payload: {} } as never,
    }),
  ).toThrow('processor "build-event" cannot build unresolved event "test/build-event/missing"');
});
