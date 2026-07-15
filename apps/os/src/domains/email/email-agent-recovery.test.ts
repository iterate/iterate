// Eviction recovery for the email-agent processor (codex review P1): the
// blocking transcription of inbound mail (attachment resolution + the
// `agents/message-received` append) is an inbound message's ONLY path to the
// LLM. It runs under `blockProcessorWhile`, so a lone agent-DO death holds
// the cursor and the subscription spine redelivers. What the spine CANNOT
// cover is the SIMULTANEOUS Agent+Stream DO death (a deploy evicts both):
// nothing is armed to dial either side again, and a quiet inbox message
// strands untranscribed. Per-runner recovery closes that — the durable alarm
// survives the death, its revival appends `stream/processor-revived` (in
// production the append cold-boots the Stream DO, whose `woken` fan-out
// restores the spine), and the ordinary redelivery of the UNACKNOWLEDGED
// frame re-runs the blocking transcription.
//
// The processor is driven the way production drives it: a REAL
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState, the in-memory MemoryStream journal,
// and a virtual clock — the same harness shape as repo-recovery.test.ts.
// `crash()` is an eviction: in-flight work dies; the journal, KV progress,
// and the durable alarm survive.

import { describe, expect, it } from "vitest";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { KEEPALIVE_ALARM_LEAD_MS } from "../streams/stream-processor-keepalive.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "../streams/core-processor-contract.ts";
import { EmailAgentProcessorContract } from "./email-agent-processor-contract.ts";
import { EmailAgentProcessor } from "./email-agent-processor-implementation.ts";

const HOME = "/agents/email/t1";
const SLUG = EmailAgentProcessorContract.slug;

/** One inbound mail with a door-stored attachment (the transcription resolves
 * it into a signed AgentFileAttachment inside the blocking work). */
function receivedPayload() {
  return {
    envelope: { from: "jonas@example.com", to: "acme@iterate.app" },
    recipient: { slug: "acme", threadId: null },
    projectId: "prj_1",
    automated: false,
    message: {
      messageId: "msg-1@mail.example",
      inReplyTo: null,
      references: [],
      from: { address: "jonas@example.com", name: "Jonas" },
      replyToAddress: null,
      subject: "Hello agent",
      text: "Can you help me with something?",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 1234,
          path: "/email/inbound/msg-0-report.pdf",
        },
      ],
    },
  };
}

const RESOLVED_FILE: AgentFileAttachment = {
  contentType: "application/pdf",
  filename: "report.pdf",
  path: "/email/inbound/msg-0-report.pdf",
  size: 1234,
  url: "https://iterate-files--acme.iterate.app/report.pdf?sig=x",
};

function makeHarness() {
  const clock = { now: Date.parse("2026-07-15T12:00:00Z") };
  const stream = new MemoryStream(HOME);
  stream.now = () => clock.now;

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

  /** Per-incarnation attachment resolution; tests reassign `impl` across
   * crashes. The default throws, so "must not resolve in this scenario" is
   * the resting state (a THROW degrades to a plain transcription — only a
   * HANG models the in-flight work an eviction takes). */
  const resolve: { impl: () => Promise<AgentFileAttachment[]> } = {
    impl: () => {
      throw new Error("must not resolve in this scenario");
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
      new EmailAgentProcessor({
        stream,
        path: HOME,
        projectId: null,
        resolveStoredAttachments: () => resolve.impl(),
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
    stream,
    kv,
    alarm,
    resolve,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** Evict the incarnation: registry, runner, and the in-flight
     * transcription die; the journal, KV progress, and the durable alarm
     * survive. */
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:email-agent",
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
  it("died mid-transcription → keepalive alarm → exactly one stream/processor-revived → the unacked frame redelivers → the transcription re-runs", async () => {
    const h = makeHarness();
    // Incarnation 1 HANGS while resolving attachments: the frame is blocked
    // inside the transcription, the attempt rides the keepalive, the revival
    // alarm is armed, and the cursor is held BEFORE the received event. The
    // frame never resolves — do not await it.
    h.resolve.impl = () => new Promise<never>(() => {});
    await h.stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload(),
    });
    const woken = await h.wake();
    void Promise.resolve(
      woken.sink({
        projectId: null,
        path: HOME,
        events: h.stream.events.filter((event) => event.offset > woken.checkpointOffset),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).catch(() => undefined);
    await h.settle();
    expect(h.alarm.at).not.toBeNull();
    expect(
      h.stream.events.some((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toBe(false);

    h.crash(); // the in-flight transcription dies; journal, KV, and the alarm survive
    h.resolve.impl = async () => [RESOLVED_FILE];
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

    // The redelivery re-runs the blocking transcription from the held cursor:
    // the inbound mail reaches the agent, attachments resolved and attached.
    await h.deliverPending();
    const inputs = h.stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [RESOLVED_FILE] });
    expect((inputs[0]!.payload as { content: string }).content).toContain(
      "Can you help me with something?",
    );

    // The idempotency-keyed transcription settles the obligation for good.
    await h.deliverPending();
    expect(
      h.stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(1);
  });
});
