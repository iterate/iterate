import { expect, test } from "vitest";
import { MediaApp } from "./index.ts";
import {
  MediaProcessorContract,
  MediaProcessor,
  searchMediaItems,
  type MediaState,
} from "./processor.ts";
import { mediaWorkerRef } from "./app-ref.ts";

function reduceAll(events: any[]): MediaState {
  // Drive the pure fold the way the registry would: contract default state,
  // then reduce each event in stream order.
  const processor = new MediaProcessor({} as any);
  let state = MediaProcessorContract.stateSchema.parse({});
  for (const event of events) {
    state = (processor as any).reduce({ event, state });
  }
  return state;
}

const captured = (stableKey: string, overrides: any = {}) => ({
  type: "events.iterate.com/media/captured",
  path: "/media",
  offset: overrides.offset || 1,
  createdAt: overrides.createdAt || "2026-08-10T10:00:00.000Z",
  payload: {
    stableKey,
    title: "Trenitalia ticket",
    path: `/media/${stableKey}-shot.png`,
    filename: "shot.png",
    contentType: "image/png",
    width: 100,
    height: 200,
    source: "library-sync",
    capturedAt: "2026-08-09T09:00:00.000Z",
    isScreenshot: true,
    markdown: "A train ticket from Rome to Florence.",
    transcript: "Trenitalia 09:45",
    tags: ["screenshot", "logistics"],
    processedBy: "test-model",
    ...overrides.payload,
  },
});

test("fold: captured inserts, processed overlays latest, unknown processed is skipped", () => {
  const state = reduceAll([
    captured("k1"),
    {
      type: "events.iterate.com/media/processed",
      path: "/media",
      offset: 2,
      createdAt: "t2",
      payload: {
        stableKey: "k1",
        title: "Trenitalia ticket (retagged)",
        markdown: "Better description.",
        transcript: "Trenitalia 09:45 Platform 3",
        tags: ["screenshot", "logistics", "receipt"],
        processedBy: "test-model-2",
      },
    },
    {
      type: "events.iterate.com/media/processed",
      path: "/media",
      offset: 3,
      createdAt: "t3",
      payload: {
        stableKey: "ghost",
        title: "",
        markdown: "x",
        transcript: "",
        tags: [],
        processedBy: "m",
      },
    },
  ]);
  expect(Object.keys(state.items)).toEqual(["k1"]);
  expect(state.items.k1).toMatchObject({
    markdown: "Better description.",
    tags: ["screenshot", "logistics", "receipt"],
    // capture facts survive the overlay
    filename: "shot.png",
    capturedEventAt: "2026-08-10T10:00:00.000Z",
  });
});

test("search: terms AND across description/transcript/filename/tags, tag filters, newest first", () => {
  const state = reduceAll([
    captured("k1", { payload: { capturedAt: "2026-08-01T00:00:00.000Z" } }),
    captured("k2", {
      offset: 2,
      payload: {
        capturedAt: "2026-08-05T00:00:00.000Z",
        markdown: "A receipt from ACME Coffee.",
        transcript: "Flat white £3.60",
        tags: ["photo", "receipt"],
      },
    }),
  ]);
  expect(searchMediaItems(state, { q: "train ticket" }).map((i) => i.stableKey)).toEqual(["k1"]);
  expect(searchMediaItems(state, { q: "flat white" }).map((i) => i.stableKey)).toEqual(["k2"]);
  expect(searchMediaItems(state, { tags: ["receipt"] }).map((i) => i.stableKey)).toEqual(["k2"]);
  expect(searchMediaItems(state, {}).map((i) => i.stableKey)).toEqual(["k2", "k1"]); // newest first
  expect(searchMediaItems(state, { q: "coffee", tags: ["screenshot"] })).toEqual([]);
});

test("glue: /media events fan into the app worker; worker-updated mounts itx.media", async () => {
  const synced: any[] = [];
  const provided: any[] = [];
  const worker = {
    [Symbol.dispose]() {},
    async syncEvent(event: any) {
      synced.push(event);
    },
  };
  const app = MediaApp.create({
    ITX: {
      async get() {
        return {
          [Symbol.dispose]() {},
          workers: { get: () => worker },
          capabilityHosts: {
            get: () => ({
              provideCapability: async (input: any) => {
                provided.push(input);
                return {};
              },
            }),
          },
        };
      },
    },
  } as any);

  await app.processEvent({ path: "/unrelated", type: "x/y" } as any);
  await app.processEvent({ path: "/media", type: "events.iterate.com/media/captured" } as any);
  await app.processEvent({
    path: "/",
    type: "events.iterate.com/project/worker-updated",
  } as any);

  expect(synced).toHaveLength(1);
  expect(provided).toHaveLength(1);
  expect(provided[0]).toMatchObject({
    type: "itx-call",
    path: ["media"],
    expression: ["workers", ["get", mediaWorkerRef]],
    flattenNestedPaths: true,
  });
});
