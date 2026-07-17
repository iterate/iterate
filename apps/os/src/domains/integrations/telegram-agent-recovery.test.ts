// Eviction recovery for the telegram-agent processor (codex review P1): its
// consequential work — the journaled send — runs under `blockProcessorWhile`,
// so a lone agent-DO death holds the cursor and the subscription spine
// redelivers. What the spine CANNOT cover is the SIMULTANEOUS Agent+Stream DO
// death (a deploy evicts both): nothing is armed to dial either side again,
// and the unmet send obligation strands on a quiet thread. Per-runner
// recovery closes that — the durable alarm survives the death, its revival
// appends the core `stream/processor-revived` fact (in production the append cold-boots the
// Stream DO, whose `woken` fan-out restores the spine), and the ordinary
// redelivery of the UNACKNOWLEDGED frame re-runs the blocking send.
//
// The processor is driven the way production drives it: a REAL
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState, the in-memory MemoryStream journal,
// and a virtual clock — the same harness shape as repo-recovery.test.ts.
// `crash()` is an eviction: in-flight work dies; the journal, KV progress,
// and the durable alarm survive.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { MemoryStreamNetwork } from "iterate/processors/testing";
import { createStreamProcessorRegistry, type StreamProcessorRegistry } from "iterate/processors";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "../streams/core-processor-contract.ts";
import { TelegramAgentProcessorContract } from "./telegram-agent-processor-contract.ts";
import { TelegramAgentProcessor } from "./telegram-agent-processor-implementation.ts";

const CONNECTION = "mishas-helper-bot";
const CHAT_ID = 42424242;
const HOME = `/agents/telegram/${CONNECTION}/chat-${CHAT_ID}`;
const SLUG = TelegramAgentProcessorContract.slug;

function makeHarness() {
  const clock = { now: Date.parse("2026-07-15T12:00:00Z") };
  const network = new MemoryStreamNetwork(() => clock.now);
  const stream = network.get(HOME);

  const kv = new Map<string, unknown>();
  const alarm: { at: number | null } = { at: null };
  let pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
      },
      getAlarm: async () => alarm.at,
      setAlarm: async (at: number | Date) => {
        alarm.at = typeof at === "number" ? at : at.getTime();
      },
      deleteAlarm: async () => {
        alarm.at = null;
      },
    },
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
  } as unknown as DurableObjectState;

  /** Per-incarnation vendor send; tests reassign `impl` across crashes. The
   * default throws, so "must not send in this scenario" is the resting state. */
  const send: { impl: (body: Record<string, unknown>) => Promise<{ messageId: number }> } = {
    impl: () => {
      throw new Error("must not send in this scenario");
    },
  };

  let registry!: StreamProcessorRegistry;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: null,
      version: "v-test",
      now: () => clock.now,
    });
    registry.register(
      new TelegramAgentProcessor({
        stream,
        path: HOME,
        projectId: null,
        sendTelegramMessage: ({ body }) => send.impl(body),
        now: () => clock.now,
      }),
      { recovery: true },
    );
  };
  boot();

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const head = () => stream.events.at(-1)?.offset ?? 0;

  const harness = {
    clock,
    network,
    stream,
    kv,
    alarm,
    send,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** Evict the incarnation: registry, runner, and the in-flight send die;
     * the journal, KV progress, and the durable alarm survive. */
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:telegram-agent",
        processorSlug: SLUG,
      });
    },
    /** Wake and push everything past the acknowledged cursor as one frame —
     * the transport's job, minimally. */
    async deliverPending() {
      const woken = await harness.wake();
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: null,
          path: HOME,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
          streamMaxOffset: head(),
          state: null,
        });
      }
      await settle();
      return woken;
    },
    /** Advance virtual time, firing the durable alarm through the REAL
     * handleAlarm path whenever it comes due within the window. */
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null; // the platform consumes the alarm by firing it
        await registry.handleAlarm();
        await settle();
      }
      clock.now = target;
    },
  };
  return harness;
}

describe("eviction recovery end to end", () => {
  it("died mid-send → keepalive alarm → exactly one stream/processor-revived → the unacked frame redelivers → the send re-runs and is marked", async () => {
    const h = makeHarness();
    // Incarnation 1 HANGS inside the Bot API call: the frame is blocked in
    // the send obligation, the attempt rides the keepalive, the revival alarm
    // is armed, and the cursor is held BEFORE the send-requested event. The
    // frame never resolves — do not await it.
    h.send.impl = () => new Promise<never>(() => {});
    await h.stream.append(
      {
        type: "events.iterate.com/telegram-agent/created",
        payload: { config: { chatId: String(CHAT_ID), connection: CONNECTION } },
      },
      {
        type: "events.iterate.com/telegram/send-requested",
        payload: { text: "The deploy is green." },
      },
    );
    const woken = await h.wake();
    void Promise.resolve(
      woken.sink({
        projectId: null,
        path: HOME,
        events: h.stream.events.filter((event) => event.offset > woken.checkpointOffset),
        scannedAfterOffset: woken.checkpointOffset,
        scannedThroughOffset: h.head(),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).catch(() => undefined);
    await h.settle();
    expect(h.alarm.at).not.toBeNull();
    expect(
      h.stream.events.some((event) => event.type === "events.iterate.com/telegram/message-sent"),
    ).toBe(false);

    h.crash(); // the in-flight send dies; journal, KV, and the alarm survive
    const sends: unknown[] = [];
    h.send.impl = async (body) => {
      sends.push(body);
      return { messageId: 777 };
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // durableObjectRecovery's revival pass journaled the processor-scoped
    // fact — in production its append cold-boots the Stream DO, whose woken
    // fan-out drives the redelivery simulated below.
    const revived = h.stream.events.filter(
      (event) => event.type === STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
    );
    expect(revived).toHaveLength(1);
    expect(revived[0]!.payload).toMatchObject({
      processorSlug: SLUG,
      revivals: 1,
      version: "v-test",
    });

    // The redelivery re-runs the blocking send from the held cursor: Bot API
    // call, journal marker, provenance claim. (At-least-once at the Telegram
    // boundary: had the dead incarnation's send reached Telegram before the
    // cursor committed, this re-send duplicates — the same caveat as the
    // legacy host; the JOURNAL stays exactly-once.)
    await h.deliverPending();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chat_id: CHAT_ID, text: "The deploy is green." });
    const marker = h.stream.events.find(
      (event) => event.type === "events.iterate.com/telegram/message-sent",
    );
    expect(marker?.payload).toMatchObject({ messageId: 777, requestOffset: 2 });
    // The provenance claim landed on the connection stream.
    expect(h.network.eventsAt(`/integrations/telegram/${CONNECTION}`).map((e) => e.type)).toEqual([
      "events.iterate.com/telegram/message-sent",
    ]);

    // The obligation is settled for good: another delivery re-sends nothing.
    await h.deliverPending();
    expect(sends).toHaveLength(1);
  });
});
