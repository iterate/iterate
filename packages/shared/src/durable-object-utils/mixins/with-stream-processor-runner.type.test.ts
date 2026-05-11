import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  implementProcessor,
  type ProcessorStreamApi,
  type StreamEvent,
} from "../../stream-processors/stream-processor.ts";
import { withDurableObjectCore } from "./with-durable-object-core.ts";
import { withLifecycleHooks } from "./with-lifecycle-hooks.ts";
import type { LifecycleInitializeInput } from "./with-lifecycle-hooks.ts";
import {
  StreamProcessorRunnerProtected,
  withStreamProcessorRunner,
  type StreamProcessorRunnerState,
} from "./with-stream-processor-runner.ts";

type CounterStructuredName = {
  streamPath: string;
};

const CounterStructuredName = z.object({
  streamPath: z.string(),
});

type CounterEnv = {
  EXAMPLE: string;
};

const CounterContract = defineProcessorContract({
  slug: "counter",
  version: "0.1.0",
  description: "Counts increment events.",
  stateSchema: z.object({
    count: z.number().int().default(0),
  }),
  events: {
    "events.iterate.com/counter/incremented": {
      payloadSchema: z.object({ by: z.number().int() }),
    },
  },
  consumes: ["events.iterate.com/counter/incremented"],
  emits: ["events.iterate.com/counter/incremented"],
  reduce({ state, event }) {
    return { count: state.count + event.payload.by };
  },
});

const CounterProcessor = implementProcessor(CounterContract, {});

const counterRunnerOptions = {
  processor() {
    return CounterProcessor;
  },
  streamApi() {
    return {} as ProcessorStreamApi<typeof CounterContract>;
  },
};

const counterRunnerMixin = withStreamProcessorRunner<
  CounterStructuredName,
  CounterEnv,
  typeof CounterContract
>(counterRunnerOptions);

const CounterRoomBase = counterRunnerMixin(
  withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: CounterStructuredName })(
    withDurableObjectCore(DurableObject),
  ),
);

class CounterRoom extends CounterRoomBase<CounterEnv> {
  getStreamPathForTest() {
    return this.structuredName.streamPath;
  }

  async catchUpForTest() {
    return await this.catchUpStreamProcessor();
  }

  async consumeForTest(event: StreamEvent) {
    return await this.consumeStreamProcessorEvent({ event });
  }
}

describe("withStreamProcessorRunner types", () => {
  it("preserves Cloudflare's generic Durable Object base shape", () => {
    expectTypeOf(CounterRoom).toMatchTypeOf<
      abstract new (ctx: DurableObjectState, env: CounterEnv) => DurableObject<CounterEnv>
    >();
  });

  it("exposes configured processor runner methods to subclasses", async () => {
    const room = {} as CounterRoom;

    expectTypeOf(await room.catchUpForTest()).toEqualTypeOf<
      StreamProcessorRunnerState<typeof CounterContract>
    >();
    expectTypeOf(await room.consumeForTest({} as StreamEvent)).toEqualTypeOf<
      StreamProcessorRunnerState<typeof CounterContract>
    >();
  });

  it("keeps runner methods off the public instance surface", () => {
    const room = {} as CounterRoom;

    // @ts-expect-error runner helpers are protected subclass APIs, not public RPC methods.
    room.catchUpStreamProcessor;
    // @ts-expect-error runner helpers are protected subclass APIs, not public RPC methods.
    room.consumeStreamProcessorEvent;

    expectTypeOf(room).toMatchTypeOf<StreamProcessorRunnerProtected<typeof CounterContract>>();
  });

  it("composes with lifecycle structured names for stream-bound runners", () => {
    const room = {} as CounterRoom;

    expectTypeOf(room.getStreamPathForTest()).toEqualTypeOf<string>();
    expectTypeOf(room.initialize).parameter(0).toEqualTypeOf<LifecycleInitializeInput>();
  });

  it("rejects bases that have not installed lifecycle and durable-object core capabilities", () => {
    // @ts-expect-error the runner persists state through core KV and reads stream path through lifecycle structured names.
    counterRunnerMixin(DurableObject);
  });
});
