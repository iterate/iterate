// The worker under test for stream-processor-durable-object.test.ts. It runs
// inside real workerd (Miniflare); the test esbuild-bundles it and drives the
// single verb `POST /run`.
//
// Unlike the facet suite (which injects its own stream through ProcessorFacet's
// createHost seam), StreamProcessorDurableObject has NO stream-injection seam —
// it goes through createProcessorHost -> itxProjectStream(env.ITX). So the DO
// swaps in a raw fake ITX (backed by the in-package MemoryStream) in its
// constructor, AFTER super() but BEFORE the lazy #host getter first runs. That
// override is exactly what proves the base reads its env lazily.
import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessorState,
  type ReduceArgs,
} from "./processors/index.ts";
import { MemoryStream } from "./processors/testing.ts";
import type { ItxBinding } from "./itx-api.generated.ts";
import { StreamProcessorDurableObject, type ProcessorHostDeps } from "./sdk.ts";

const STREAM_PATH = "/test/counter";
// The registry fences persisted checkpoints on a random stream identity, and
// requires a UUID — a fixed v4 literal keeps the wake request and the store in
// agreement.
const STREAM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "proj_test";

// One store shared across every `env.ITX.get()`, built lazily: MemoryStream's
// field initializer calls crypto.randomUUID(), which workerd forbids at global
// scope, so it must not be constructed at module load.
let storeSingleton: MemoryStream | undefined;
function getStore(): MemoryStream {
  if (storeSingleton === undefined) {
    storeSingleton = new MemoryStream(STREAM_PATH);
    storeSingleton.streamId = STREAM_ID;
  }
  return storeSingleton;
}

// A raw same-isolate fake ITX: itxProjectStream only ever reaches
// `project.streams.get(path)`, so that is all we implement.
const fakeItx = {
  fetch: async () => new Response("no", { status: 404 }),
  get: async () => ({
    projectId: PROJECT_ID,
    streams: { get: () => getStore() },
    [Symbol.dispose]() {},
  }),
};

type TestEnv = { ITERATE_WORKER_VERSION: string; ITX: ItxBinding };
type RunResult = { preCount: number; checkpoint: number; postCount: number };

const CounterContract = defineProcessorContract({
  slug: "counter",
  version: "0.1.0",
  description: "Sums counter bumps — a minimal effect-free processor.",
  stateSchema: z.object({
    count: z.number().default(0).meta({ description: "Running total of all bumps." }),
  }),
  events: {
    "counter/bumped": {
      description: "Add `by` to the running count.",
      payloadSchema: z.object({ by: z.number().meta({ description: "Amount to add." }) }),
      examples: [{ description: "Bump by two.", payload: { by: 2 } }],
    },
  },
  consumes: ["counter/bumped"],
  emits: [],
});
type CounterContract = typeof CounterContract;
type CounterState = ProcessorState<CounterContract>;

/** Pure fold, no side effects — so the runner never arms a keepalive alarm. */
class CounterProcessor extends StreamProcessor<CounterContract> {
  readonly contract = CounterContract;
  protected override reduce({ event, state }: ReduceArgs<CounterContract>): CounterState {
    if (event.type === "counter/bumped") return { ...state, count: state.count + event.payload.by };
    return state;
  }
}

export class TestProcessorDO extends StreamProcessorDurableObject<CounterState, TestEnv> {
  // The `streamPath` override is the ordering-trap discriminator: the base's
  // lazy `#host` getter reads it (and `recovery`, on the same line) only on
  // first use, after construction, so a subclass field override is honored. If
  // the host were an eager base field it would capture the base default
  // (undefined) and this fixed home stream would be lost.
  protected readonly streamPath = STREAM_PATH;
  protected createProcessor(deps: ProcessorHostDeps): CounterProcessor {
    return new CounterProcessor(deps);
  }

  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    // Install the fake ITX before any door/alarm access builds the host. The
    // cast is the whole point of the fake: itxProjectStream only reaches
    // `project.streams.get(path)`, so a minimal same-isolate double stands in
    // for the full generated ItxBinding.
    this.env = { ...this.env, ITX: fakeItx as unknown as ItxBinding };
  }

  /** Drive wake -> fold -> snapshot end-to-end, in one in-process turn. */
  async run(): Promise<RunResult> {
    // (1) Ordering-trap proof: a pre-wake snapshot only succeeds if `streamPath`
    // was honored (a fixed home stream lets the host build before any wake). Had
    // the base-field-init trap bitten, streamPath would read undefined and
    // buildOutsideWake would throw "learns its stream from the first wake".
    const pre = await this.snapshot();

    const store = getStore();
    await store.append({ type: "counter/bumped", payload: { by: 2 } });

    const resp = await this.processor.wakeStreamProcessor({
      stream: { projectId: PROJECT_ID, path: STREAM_PATH, streamId: STREAM_ID, streamMaxOffset: 1 },
      name: "counter",
    });

    await new Promise<void>((resolve, reject) => {
      try {
        resp.processEventBatch({
          projectId: PROJECT_ID,
          path: STREAM_PATH,
          streamId: resp.streamId,
          events: store.events,
          scannedAfterOffset: 0,
          scannedThroughOffset: 1,
          streamMaxOffset: 1,
          state: null,
          reportDeliveryResult: (result) =>
            result.outcome === "ok" ? resolve() : reject(new Error(result.error.message)),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const post = await this.snapshot();
    return {
      preCount: pre.state.count,
      checkpoint: resp.checkpointOffset,
      postCount: post.state.count,
    };
  }
}

// Structural binding type — this package's tsconfig doesn't pull in the
// Cloudflare `DurableObjectNamespace` global, and the facet suite types its DO
// binding the same way.
type TestDoNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { run(): Promise<RunResult> };
};

export default {
  async fetch(request: Request, env: { TESTDO: TestDoNamespace }): Promise<Response> {
    if (new URL(request.url).pathname !== "/run") return new Response("not found", { status: 404 });
    const stub = env.TESTDO.get(env.TESTDO.idFromName("singleton"));
    return Response.json(await stub.run());
  },
};
