// The StreamProcessor base class under REAL runner drive. Everything here
// exercises the KEPT authoring surface — the append lanes with provenance
// stamping, idempotency keys, the self-measured subscriber metrics, and the
// runner's committed-state observation. Delivery mechanics (cursors, refolds,
// parse-failure skipping, crash/redelivery, onCaughtUp gating) live in
// stream-processor-runner.test.ts, the executable spec.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
import { StreamProcessor, type StreamProcessorContract } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";

const CounterContract = defineProcessorContract({
  slug: "test-counter",
  version: "0.0.1",
  description: "Counts increments; exists to test the base class + runner pair.",
  stateSchema: z.object({ count: z.number().default(0) }),
  events: {
    "events.iterate.com/test/incremented": {
      description: "The counter was incremented.",
      payloadSchema: z.object({ by: z.number() }),
    },
  },
  consumes: ["events.iterate.com/test/incremented"],
  emits: [],
});

class CounterProcessor extends StreamProcessor<typeof CounterContract> {
  readonly contract = CounterContract;

  protected override reduce({
    event,
    state,
  }: {
    event: { payload: { by: number } };
    state: { count: number };
  }) {
    return { count: state.count + event.payload.by };
  }
}

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

/** REAL runner drive with hand-built frames (offsets preserved verbatim). */
function drive<Contract extends StreamProcessorContract, Deps extends object>(
  processor: StreamProcessor<Contract, Deps>,
  stream: Stream = neverStream,
) {
  const runner = new StreamProcessorRunner({ processor, stream });
  return {
    runner,
    async deliver(frame: { events: StreamEvent[]; streamMaxOffset: number }) {
      const opened = await runner.openDelivery();
      await opened.sink({
        ...frame,
        scannedAfterOffset: opened.checkpointOffset,
        scannedThroughOffset: frame.events.at(-1)?.offset ?? opened.checkpointOffset,
      });
    },
  };
}

let nextOffset = 0;
function incrementedEvent(by: number, offset?: number): StreamEvent {
  nextOffset = offset ?? nextOffset + 1;
  return {
    type: "events.iterate.com/test/incremented",
    payload: { by },
    createdAt: new Date(nextOffset).toISOString(),
    offset: nextOffset,
    path: "/tests/counter",
  };
}

function unrelatedEvent(offset?: number): StreamEvent {
  nextOffset = offset ?? nextOffset + 1;
  return {
    type: "events.iterate.com/other/happened",
    createdAt: new Date(nextOffset).toISOString(),
    offset: nextOffset,
    path: "/tests/counter",
  };
}

function counter() {
  nextOffset = 0;
  return drive(
    new CounterProcessor({ stream: neverStream, path: "/tests/counter", projectId: null }),
  );
}

describe("committed-state observation under runner drive", () => {
  it("notifies the observer with the new snapshot after every state-changing frame", async () => {
    const { runner, deliver } = counter();
    const snapshots: { offset: number; state: { count: number } }[] = [];
    runner.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await deliver({ events: [incrementedEvent(2)], streamMaxOffset: 1 });
    await deliver({
      events: [incrementedEvent(3), incrementedEvent(5)],
      streamMaxOffset: 3,
    });

    expect(snapshots).toEqual([
      { offset: 1, state: { count: 2 } },
      { offset: 3, state: { count: 10 } },
    ]);
  });

  it("does not notify when a frame leaves state unchanged", async () => {
    const { runner, deliver } = counter();
    const snapshots: unknown[] = [];
    runner.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await deliver({ events: [unrelatedEvent()], streamMaxOffset: 1 });

    expect(snapshots).toHaveLength(0);
    await expect(runner.snapshot()).resolves.toEqual({ offset: 1, state: { count: 0 } });
  });

  it("stops notifying after unsubscribe; currentState reflects the fold", async () => {
    const { runner, deliver } = counter();
    const snapshots: unknown[] = [];
    const unsubscribe = runner.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await deliver({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
    expect(snapshots).toHaveLength(1);
    expect(runner.currentState).toEqual({ count: 1 });

    unsubscribe();
    await deliver({ events: [incrementedEvent(1)], streamMaxOffset: 2 });
    expect(snapshots).toHaveLength(1);
  });
});

// Every append a processor makes through the emitted lanes carries
// `source.processor`: who appended (slug/version + home stream) and — on the
// per-event lanes — while processing which event. These tests pin the stamp's
// shape, the overwrite rule, and the at-head lane's omission of
// `whileProcessing`.
describe("StreamProcessor provenance stamping", () => {
  const EchoContract = defineProcessorContract({
    slug: "test-echo",
    version: "0.0.1",
    description: "Echoes triggers; exists to test append-lane provenance stamping.",
    stateSchema: z.object({ seen: z.number().default(0) }),
    events: {
      "events.iterate.com/test/triggered": {
        description: "A trigger the echo processor consumes.",
        payloadSchema: z.object({ id: z.string() }),
      },
      "events.iterate.com/test/echoed": {
        description: "The echo emitted in response to a trigger.",
        payloadSchema: z.object({ id: z.string() }),
      },
    },
    consumes: ["events.iterate.com/test/triggered"],
    emits: ["events.iterate.com/test/echoed"],
  });

  const HOME = { path: "/tests/echo", projectId: "prj_echo" };
  const STAMP = { slug: "test-echo", version: "0.0.1", stream: HOME };

  function triggeredEvent(offset: number): StreamEvent {
    return {
      type: "events.iterate.com/test/triggered",
      payload: { id: `t${offset}` },
      createdAt: new Date(offset).toISOString(),
      offset,
      path: HOME.path,
    };
  }

  // A stream whose own appends AND `at(path)` children record into one log,
  // tagged with the destination path.
  function recordingNetwork() {
    const appends: { path: string; event: StreamEventInput }[] = [];
    const streamAt = (path: string): Stream =>
      ({
        append: (...events: StreamEventInput[]) => {
          appends.push(...events.map((event) => ({ path, event })));
          return Promise.resolve(
            events.map((event, index) => ({
              ...event,
              offset: 1_000 + appends.length + index,
              createdAt: new Date(0).toISOString(),
              path,
            })),
          );
        },
        at: (child: string) => streamAt(child),
      }) as unknown as Stream;
    return { appends, stream: streamAt(HOME.path) };
  }

  class EchoProcessor extends StreamProcessor<typeof EchoContract> {
    readonly contract = EchoContract;

    protected override processEvent({
      event,
      append,
      appendTo,
      blockProcessorWhile,
    }: Parameters<StreamProcessor<typeof EchoContract>["processEvent"]>[0]): undefined {
      if (event === null) return; // event-less at-head pass: no per-event echo
      const echo = {
        type: "events.iterate.com/test/echoed" as const,
        idempotencyKey: this.idempotencyKey("echo", event),
        payload: { id: event.payload.id },
      };
      blockProcessorWhile(async () => {
        await append(echo);
        await appendTo("/tests/echo-sibling", {
          ...echo,
          // The caller's stamp claim must lose to the framework's.
          source: { processor: { slug: "forged", version: "9", stream: HOME } },
        });
      });
    }
  }

  // At-head appends are derived from the whole fold, not one event — the
  // at-head reconcile (processEvent under `delivery.caughtUp`) runs them,
  // riding the LAST CONSUMED event of a head-reaching batch. That event is the
  // one the append is stamped with (the reconcile has no batch-level unstamped
  // lane; obligation-stability comes from the idempotency KEY, not the stamp).
  class CaughtUpEchoProcessor extends StreamProcessor<typeof EchoContract> {
    readonly contract = EchoContract;

    protected override processEvent(
      args: Parameters<StreamProcessor<typeof EchoContract>["processEvent"]>[0],
    ): undefined {
      if (!args.delivery.caughtUp) return;
      args.blockProcessorWhile(() =>
        args.append({
          type: "events.iterate.com/test/echoed",
          idempotencyKey: this.idempotencyKey(
            `at-head-summary:${args.delivery.observedHeadOffset}`,
          ),
          payload: { id: "at-head" },
        }),
      );
    }
  }

  it("stamps per-event appends with the processor and the event being processed", async () => {
    const { appends, stream } = recordingNetwork();
    const { deliver } = drive(new EchoProcessor({ stream, ...HOME }), stream);

    await deliver({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const home = appends.filter(({ path }) => path === HOME.path);
    expect(home).toHaveLength(1);
    expect(home[0]!.event).toMatchObject({
      idempotencyKey: "test-echo/echo@/tests/echo:7",
      source: {
        processor: {
          ...STAMP,
          whileProcessing: { offset: 7, type: "events.iterate.com/test/triggered" },
        },
      },
    });
  });

  it("self-measured metrics: home appends open the consume-own-append loop; delivery past the committed offset closes it", async () => {
    const { stream } = recordingNetwork();
    const processor = new EchoProcessor({ stream, ...HOME });
    const { deliver } = drive(processor, stream);

    // The trigger makes the processor append its echo (home commits at offset
    // 1001 in the recording network) plus a sibling copy — only the HOME
    // append is timed: the sibling never loops back through this subscription.
    await deliver({ events: [triggeredEvent(7)], streamMaxOffset: 7 });
    let report = processor.subscriberMetrics.report();
    expect(report.appendRoundTripMs).toMatchObject({ samples: 1 });
    expect(report.consumeOwnAppendMs).toBeNull(); // echo not delivered back yet
    expect(report.batchesIngested).toBe(1);
    expect(report.eventsIngested).toBe(1);
    expect(report.ingestMs).not.toBeNull();

    // A later (non-consumed) event past the committed echo offset advances the
    // acknowledged cursor through it — the loop closes on real delivery, not
    // on append.
    await deliver({
      events: [
        {
          type: "events.iterate.com/test/unrelated",
          offset: 1_500,
          createdAt: new Date(1_500).toISOString(),
          path: HOME.path,
          payload: {},
        },
      ],
      streamMaxOffset: 1_500,
    });
    report = processor.subscriberMetrics.report();
    expect(report.consumeOwnAppendMs).toMatchObject({ samples: 1 });
    expect(report.appendRoundTripMs).toMatchObject({ samples: 1 });
  });

  it("appendTo lands on the sibling stream with the same stamp, overwriting claims", async () => {
    const { appends, stream } = recordingNetwork();
    const { deliver } = drive(new EchoProcessor({ stream, ...HOME }), stream);

    await deliver({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const sibling = appends.filter(({ path }) => path === "/tests/echo-sibling");
    expect(sibling).toHaveLength(1);
    expect(sibling[0]!.event.source?.processor).toEqual({
      ...STAMP,
      whileProcessing: { offset: 7, type: "events.iterate.com/test/triggered" },
    });
  });

  it("runs the at-head reconcile on the last consumed event of a head-reaching batch, keyed by the fold not the event", async () => {
    const { appends, stream } = recordingNetwork();
    const { deliver } = drive(new CaughtUpEchoProcessor({ stream, ...HOME }), stream);

    // A consumed event at head carries `caughtUp`: the reconcile runs over the
    // whole fold. Its idempotency key is derived from the FOLD (the observed
    // head offset), not the event — that is what keeps an obligation stable
    // across redelivery; the `whileProcessing` stamp just records the consumed
    // event the reconcile rode in on.
    await deliver({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const summary = appends.find(({ event }) => event.idempotencyKey?.includes("at-head-summary"));
    expect(summary?.event.idempotencyKey).toBe("test-echo/at-head-summary:7");
    expect(summary?.event.source?.processor).toMatchObject({
      ...STAMP,
      whileProcessing: { offset: 7, type: "events.iterate.com/test/triggered" },
    });
  });

  it("refuses to append an event type missing from emits, on both lanes", () => {
    const { stream } = recordingNetwork();
    const processor = new (class extends StreamProcessor<typeof EchoContract> {
      readonly contract = EchoContract;
      emitForeign() {
        return this.append({
          type: "events.iterate.com/test/triggered",
          payload: { id: "x" },
        } as never);
      }
      forwardForeign() {
        return this.appendTo("/tests/echo-sibling", {
          type: "events.iterate.com/test/triggered",
          payload: { id: "x" },
        } as never);
      }
    })({ stream, ...HOME });

    expect(() => processor.emitForeign()).toThrow(/cannot build emitted event/);
    expect(() => processor.forwardForeign()).toThrow(/cannot build emitted event/);
  });
});

describe("contract event-input envelope", () => {
  it("accepts ephemeral: true on an emitted input (the strict envelope must know the key)", () => {
    // Load-bearing: getEventInputSchema is .strict(), so without `ephemeral`
    // in the envelope every processor-lane ephemeral append (the agent's LLM
    // chunks) would throw "Unrecognized key" at parse.
    const parsed = CounterContract.parseEventInput("events.iterate.com/test/incremented", {
      type: "events.iterate.com/test/incremented",
      ephemeral: true,
      payload: { by: 1 },
    });
    expect(parsed.ephemeral).toBe(true);
  });
});
