// The flagship recovery scenarios: the REAL production drive — a
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState — plus the single agent processor
// (schedules AND runs LLM via env.AI) in plain node, with eviction as a
// first-class operator. Deploy mid-LLM-call, lost debounce timer, stale
// request delivered a week late — the same harness shape as
// repo-recovery.test.ts / capability-host-recovery.test.ts. `crash()` is an
// eviction: in-flight work and timers die behind an incarnation fence; the
// journal, KV progress, and the durable alarm survive.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { MemoryStream, MemoryStreamNetwork } from "iterate/processors/testing";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { StreamProcessorRunner, type ProcessorProgress } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "../streams/core-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import {
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
} from "./agent-processor-contract.ts";

const T = {
  created: "events.iterate.com/agent/created",
  context: "events.iterate.com/agents/context-added",
  scheduled: "events.iterate.com/agent/llm-request-scheduled",
  requested: "events.iterate.com/agent/llm-request-requested",
  started: "events.iterate.com/agent/llm-request-started",
  completed: "events.iterate.com/agent/llm-request-completed",
  cancelled: "events.iterate.com/agent/llm-request-cancelled",
  revived: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} as const;

const birthCertificate = {
  config: {
    llm: { model: DEFAULT_AGENT_MODEL },
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  },
};

function seedAgentBirth(stream: MemoryStream): void {
  stream.events.push({
    type: T.created,
    idempotencyKey: `agent/created:test:${stream.path}`,
    payload: birthCertificate,
    createdAt: new Date(stream.now()).toISOString(),
    offset: 1,
    path: stream.path,
  });
}

function createdAgentStream(): MemoryStream {
  const stream = new MemoryStreamNetwork().get("/agents/test");
  seedAgentBirth(stream);
  return stream;
}

const SLUG = AgentProcessorContract.slug;
type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;

/** The runner-backed fold read the REQUIRED `reads` dep serves (the idle
 * debounce timer's fire-time staleness check). */
type AgentSnapshotReads = { snapshot(): Promise<{ offset: number; state: AgentState }> };

/** The read surface driving each processor (`registry.reads(...)` in the
 * harness, the runner itself under `agentRunner`), recorded post-registration
 * so `makeAgentProcessor`'s lazily-wired `reads` dep answers from it — the
 * mirror of the DO wiring `registry.reads(processor)`. */
const runnerReadsByProcessor = new WeakMap<AgentProcessor, AgentSnapshotReads>();

/** Identical to `new AgentProcessor(...)` except the REQUIRED runner-backed
 * `reads` dep is wired lazily to whatever read surface ends up driving this
 * processor (see runnerReadsByProcessor). */
function makeAgentProcessor(
  deps: Omit<ConstructorParameters<typeof AgentProcessor>[0], "reads">,
): AgentProcessor {
  const processor: AgentProcessor = new AgentProcessor({
    ...deps,
    reads: {
      snapshot: () => {
        const reads = runnerReadsByProcessor.get(processor);
        if (reads === undefined) {
          throw new Error("nothing drives this processor yet — register/agentRunner wires reads");
        }
        return reads.snapshot();
      },
    },
  });
  return processor;
}

function makeHarness() {
  const clock = { now: Date.parse("2026-07-09T12:00:00Z") };
  const stream = new MemoryStreamNetwork().get("/agents/test");
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

  let incarnation = 0;
  let registry!: StreamProcessorRegistry;
  const boot = () => {
    incarnation += 1;
    const mine = incarnation;
    // The fence: a dead incarnation's stray closures (a debounce timer, a
    // hung vendor call resolving late) must not reach the journal — exactly
    // as an evicted isolate cannot. Without it a surviving 250ms debounce
    // timer could fire the requested event the REVIVAL is supposed to
    // re-derive, and the lost-debounce test would pass vacuously.
    const fencedStream = new Proxy(stream, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (incarnation !== mine) {
            throw new Error(`stream call from evicted incarnation ${mine}`);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as Stream;
    registry = createStreamProcessorRegistry(ctx, {
      stream: fencedStream,
      path: stream.path,
      projectId: null,
      version: "v-test",
      now: () => clock.now,
    });
    const processor = makeAgentProcessor({
      stream: fencedStream,
      path: stream.path,
      projectId: null,
      now: () => clock.now,
      // Incarnation 1's AI hangs after accept — the request an eviction
      // kills mid-flight. Incarnation 2 answers with a fenced script.
      ai: {
        async run() {
          if (mine === 1) {
            await new Promise(() => {});
            return { response: "unreachable" };
          }
          return {
            response:
              "```ts\nasync (itx) => {\n  await itx.chat.sendMessage('recovered!');\n}\n```",
          };
        },
      },
    });
    registry.register(processor, { recovery: true });
    // The DO's `#reads = registry.reads(processor)` wiring, per incarnation.
    runnerReadsByProcessor.set(processor, registry.reads(processor));
  };
  boot();

  const head = () => stream.events.at(-1)?.offset ?? 0;

  const harness = {
    clock,
    stream,
    kv,
    alarm,
    get registry() {
      return registry;
    },
    /** Evict the incarnation: registry, runner, live executions, timers, and
     * pending waitUntil work die behind the fence; the journal, KV progress,
     * and the durable alarm survive. */
    crash() {
      pending = [];
      boot();
    },
    /** Wake and push everything past the acknowledged cursor as one frame —
     * the transport's job, minimally (pump-friendly: overlapping calls are
     * serialized on the runner's chain and offset-deduped). */
    async deliverPending() {
      const woken = await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: stream.path, streamMaxOffset: head() },
        subscriptionKey: "wake:agent",
        processorSlug: SLUG,
      });
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: null,
          path: stream.path,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
          streamMaxOffset: head(),
          state: null,
        });
      }
    },
    /** Advance virtual time, firing the durable alarm through the REAL
     * handleAlarm path whenever it comes due within the window — the whole
     * keepalive/revival/breaker machinery runs live. */
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null; // the platform consumes the alarm by firing it
        await registry.handleAlarm();
      }
      clock.now = target;
    },
  };
  return harness;
}

describe("eviction recovery, end to end", () => {
  // The pump plays the spine's delivery role: pull-deliver on a short real
  // interval while virtual time drives alarms/expiry. Frames are serialized
  // and offset-deduped by the runner, so overlapping pumps are safe.
  let pump: ReturnType<typeof setInterval>;
  let h: ReturnType<typeof makeHarness>;
  beforeEach(async () => {
    h = makeHarness();
    pump = setInterval(() => void h.deliverPending().catch(() => undefined), 10);
    await h.stream.append(
      {
        type: T.created,
        payload: birthCertificate,
      },
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { model: "gpt-test" } } },
      },
      {
        type: T.context,
        payload: { role: "system", key: "agent/system-prompt", content: "You are helpful." },
      },
    );
  });
  afterEach(() => {
    clearInterval(pump);
  });

  it("resumes a deploy-killed turn: alarm → revival → durable-object-crashed cancel → fresh request → reply", async () => {
    await h.stream.append({
      type: T.context,
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "hello?",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });

    // Incarnation 1 accepts the request and hangs on the AI binding.
    const started = await h.stream.waitForEvent({ eventTypes: [T.started], timeoutMs: 5_000 });
    const inFlightRequestOffset = h.stream.events.find((e) => e.type === T.requested)!.offset;
    // In-flight work parked a durable revival alarm ahead of itself.
    expect(h.alarm.at).not.toBeNull();

    h.crash(); // THE DEPLOY: isolate gone, journal + progress + alarm survive

    await h.advance(15_000); // the alarm fires; the whole revival pass runs live

    // The journal narrates the crash: the request that died, the revival, and
    // a cancel (not a failed llm-request-completed) for the in-flight attempt.
    const revived = await h.stream.waitForEvent({ eventTypes: [T.revived], timeoutMs: 5_000 });
    expect(revived.offset).toBeGreaterThan(started.offset);
    expect(revived.payload).toMatchObject({ processorSlug: SLUG, revivals: 1 });
    const crashCancel = await h.stream.waitForEvent({
      eventTypes: [T.cancelled],
      predicate: (event) =>
        (event.payload as { llmRequestOffset: number }).llmRequestOffset === inFlightRequestOffset,
      timeoutMs: 5_000,
    });
    expect(crashCancel.payload).toMatchObject({
      phase: "requested",
      reason: "durable-object-crashed",
      llmRequestOffset: inFlightRequestOffset,
    });
    // In-flight death is a cancel, not a completed failure.
    expect(
      h.stream.events.some(
        (event) =>
          event.type === T.completed &&
          (event.payload as { llmRequestOffset: number }).llmRequestOffset ===
            inFlightRequestOffset,
      ),
    ).toBe(false);
    expect(started).toBeDefined();

    // The cancel re-queued the trigger: the user asked and never got an
    // answer, so incarnation 2 must run a FRESH request (new offset) and
    // actually reply — a deploy mid-turn cannot silently eat the question.
    const resumedRequested = await h.stream.waitForEvent({
      afterOffset: crashCancel.offset,
      eventTypes: [T.requested],
      timeoutMs: 5_000,
    });
    expect(resumedRequested.offset).toBeGreaterThan(inFlightRequestOffset);
    const output = await h.stream.waitForEvent({
      eventTypes: [T.context],
      predicate: (event) => {
        const payload = event.payload as { role?: unknown; llmRequestOffset?: unknown } | undefined;
        return (
          payload?.role === "assistant" && payload.llmRequestOffset === resumedRequested.offset
        );
      },
      timeoutMs: 5_000,
    });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("recovered!"),
      llmRequestOffset: resumedRequested.offset,
    });
  });

  it("recovers a lost debounce timer: revival re-derives the requested event from the fold", async () => {
    await h.stream.append({
      type: T.context,
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "are you there?",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    const scheduled = await h.stream.waitForEvent({ eventTypes: [T.scheduled], timeoutMs: 5_000 });
    // The armed debounce is keepalive-tracked work; wait until the runner has
    // FOLDED the scheduled event (the timer exists) before evicting, so the
    // eviction provably takes an armed timer with it.
    await h.stream.waitForEvent({
      eventTypes: [T.scheduled],
      predicate: () => h.alarm.at !== null,
      timeoutMs: 5_000,
    });

    h.crash(); // evicted BEFORE the debounce fired; the timer is gone

    await h.advance(15_000);
    // The revival pass appends stream/processor-revived; its ordinary delivery drives
    // the runner to head, where the at-head reconciliation finds scheduled +
    // no live timer → requested immediately, keyed on the scheduled offset so
    // a concurrently-surviving timer could never double-fire it.
    await h.stream.waitForEvent({ eventTypes: [T.revived], timeoutMs: 5_000 });
    const requested = await h.stream.waitForEvent({ eventTypes: [T.requested], timeoutMs: 5_000 });
    expect(requested.idempotencyKey).toBe(`agent/llm-request-requested@${scheduled.offset}`);

    const output = await h.stream.waitForEvent({
      eventTypes: [T.context],
      predicate: (event) => (event.payload as { role?: unknown } | undefined)?.role === "assistant",
      timeoutMs: 5_000,
    });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("recovered!"),
    });
  });
});

/** REAL runner drive for the non-eviction obligation scenarios: `onCaughtUp`
 * (obligations + scheduling) fires only under the runner — legacy `ingest`
 * would skip the very lane under test. `seeded` pre-loads durable progress,
 * the runner-drive form of the legacy `readState` checkpoint injection. */
function agentRunner(
  processor: AgentProcessor,
  stream: MemoryStream,
  opts: { seeded?: { offset: number; state: AgentState } } = {},
) {
  const track = <Runner extends AgentSnapshotReads>(runner: Runner): Runner => {
    runnerReadsByProcessor.set(processor, runner);
    return runner;
  };
  const seeded = opts.seeded;
  if (seeded === undefined) return track(new StreamProcessorRunner({ processor, stream }));
  let record: ProcessorProgress<AgentState> = {
    reduction: {
      reducerVersion: AgentProcessorContract.version,
      reducedThroughOffset: seeded.offset,
      state: seeded.state,
    },
    processing: { acknowledgedThroughOffset: seeded.offset, cursorRevision: 0 },
  };
  return track(
    new StreamProcessorRunner({
      processor,
      stream,
      durability: {
        progress: {
          read: () => record,
          commit: (progress) => {
            record = progress;
          },
        },
      },
    }),
  );
}

describe("attempt bookkeeping under stream failures", () => {
  it("a failed started-append leaves the obligation requested and releases the live-set (no leak, retried later)", async () => {
    const stream = createdAgentStream();
    let failStartedAppends = true;
    const realAppend = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      if (failStartedAppends && inputs.some((input) => input.type === T.started)) {
        throw new Error("stream hiccup");
      }
      return realAppend(...inputs);
    };
    let dials = 0;
    const agent = makeAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          dials += 1;
          return { response: "late but fine" };
        },
      },
      now: () => Date.now(),
    });
    const runner = agentRunner(agent, stream);
    await realAppend({
      type: T.requested,
      payload: { model: "gpt-test", requestId: "llm-request:gen-1" },
    });
    const requested = stream.events.at(-1)!;
    await runner.catchUp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The attempt died before dialing; nothing was settled, nothing leaked.
    expect(dials).toBe(0);
    expect(stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(runner.currentState.llmRequests[String(requested.offset)]).toMatchObject({
      status: "requested",
    });

    // The stream recovers; the next at-head pass retries the whole attempt —
    // a leaked live-set entry would make it skip this id forever.
    failStartedAppends = false;
    await realAppend({ type: "events.iterate.com/test/nudge", payload: {} });
    await runner.catchUp();
    await vi.waitFor(() => {
      const completion = stream.events.find(
        (event) =>
          event.type === T.completed &&
          (event.payload as { llmRequestOffset: number }).llmRequestOffset === requested.offset,
      );
      expect(completion?.payload).toMatchObject({ result: { status: "success" } });
    });
    expect(dials).toBe(1);
  });
});

describe("staleness policy (only-settle-past-expiry)", () => {
  it("settles an expired request as failure without ever dialing the AI binding", async () => {
    const stream = createdAgentStream();
    const agent = makeAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          throw new Error("must not dial for expired intent");
        },
      },
      now: () => Date.now(),
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: {
        model: "gpt-test",
        requestId: "llm-request:gen-1",
        expiresAt: Date.now() - 1, // the host slept past the intent's horizon
      },
    });
    await agentRunner(agent, stream).catchUp();
    await vi.waitFor(() => {
      const completion = stream.events.find((event) => event.type === T.completed);
      expect(completion?.payload).toMatchObject({
        llmRequestOffset: requested!.offset,
        result: { status: "failure", error: { message: expect.stringContaining("expired") } },
      });
    });
  });

  it("the agent's backstop settles a request that never completed", async () => {
    const stream = createdAgentStream();
    const now = Date.now();
    // Reached-by-lifecycle state, seeded as durable progress: a request
    // accepted long ago whose LLM attempt never finished.
    const stuck = AgentProcessorContract.stateSchema.parse({
      birthCertificate,
      config: birthCertificate.config,
      currentRequest: {
        phase: "requested",
        llmRequestOffset: 2,
        requestedAt: now - AGENT_LLM_REQUEST_BACKSTOP_MS - 1,
      },
    });
    const agent = makeAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      now: () => now,
    });
    // The progress sits at offset 2; give the journal that history so the
    // nudge lands past it instead of being filtered as already-processed.
    await stream.append({ type: T.requested, payload: { model: "m", requestId: "r" } });
    const runner = agentRunner(agent, stream, { seeded: { offset: 2, state: stuck } });
    await stream.append({
      type: T.context,
      payload: {
        role: "user",
        actor: { type: "user", origin: "web" },
        content: "hello? anyone?",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    await runner.catchUp();

    const backstop = stream.events.find((event) => event.type === T.completed);
    expect(backstop?.idempotencyKey).toBe("agent/llm-request-completed@2");
    expect(backstop?.payload).toMatchObject({
      llmRequestOffset: 2,
      result: { status: "failure", error: { message: expect.stringContaining("backstop") } },
    });
  });

  it("a request past BOTH the expiry and the backstop horizon settles exactly once", async () => {
    const stream = createdAgentStream();
    // requestedAt comes from the journaled event's wall-clock createdAt; run
    // the processor's clock far enough ahead that the expired-obligation pass
    // AND the backstop both want to settle this request in the same at-head
    // pass.
    const now = Date.now() + AGENT_LLM_REQUEST_BACKSTOP_MS + 60_000;
    const agent = makeAgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      ai: {
        async run() {
          throw new Error("must not dial a long-expired request");
        },
      },
      now: () => now,
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: { model: "m", requestId: "r", expiresAt: now - 1 },
    });
    await agentRunner(agent, stream).catchUp();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completions = stream.events.filter((event) => event.type === T.completed);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.payload).toMatchObject({
      llmRequestOffset: requested!.offset,
      result: { status: "failure" },
    });
  });
});
