// The flagship recovery scenarios: REAL host (keepalive, alarm, revival) +
// the single agent processor (schedules AND runs LLM via env.AI) in plain
// node, with eviction as a first-class operator. Deploy mid-LLM-call, lost
// debounce timer, stale request delivered a week late — each against the
// harness in ../streams/test-helpers.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTestEvents,
  createProcessorHostHarness,
  MemoryStream,
  type ProcessorHostHarness,
} from "../streams/test-helpers.ts";
import { PROCESSOR_HOST_REVIVED_EVENT_TYPE } from "../streams/stream-processor-host.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import {
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
} from "./agent-processor-contract.ts";

const T = {
  userMessage: "events.iterate.com/agents/message-received",
  scheduled: "events.iterate.com/agent/llm-request-scheduled",
  requested: "events.iterate.com/agent/llm-request-requested",
  started: "events.iterate.com/agent/llm-request-started",
  completed: "events.iterate.com/agent/llm-request-completed",
  cancelled: "events.iterate.com/agent/llm-request-cancelled",
  output: "events.iterate.com/agent/output-added",
  revived: PROCESSOR_HOST_REVIVED_EVENT_TYPE,
} as const;

function agentHarness() {
  return createProcessorHostHarness({
    build: (host, ctx) => {
      // Incarnation 1's AI hangs after accept — the request an eviction kills
      // mid-flight. Incarnation 2 answers with a fenced script.
      const agent = host.add(
        (deps) =>
          new AgentProcessor({
            ...deps,
            now: () => ctx.clock.now,
            ai: {
              async run() {
                if (ctx.incarnation === 1) {
                  await new Promise(() => {});
                  return { response: "unreachable" };
                }
                return {
                  response:
                    "```ts\nasync (itx) => {\n  await itx.chat.sendMessage('recovered!');\n}\n```",
                };
              },
            },
          }),
      );
      return { agent };
    },
  });
}

describe("eviction recovery, end to end", () => {
  // The pump plays the spine's delivery role: pull-deliver on a short real
  // interval while virtual time drives alarms/expiry. catchUp is serialized
  // and offset-deduped, so overlapping pumps are safe.
  let pump: ReturnType<typeof setInterval>;
  let h: ProcessorHostHarness<{ agent: AgentProcessor }>;
  beforeEach(async () => {
    h = agentHarness();
    pump = setInterval(() => void h.deliverAll(), 10);
    await h.stream.append({
      type: "events.iterate.com/agent/llm-provider-selected",
      payload: { model: "gpt-test" },
    });
  });
  afterEach(() => {
    clearInterval(pump);
  });

  it("resumes a deploy-killed turn: alarm → revival → durable-object-crashed cancel → fresh request → reply", async () => {
    await h.stream.append({
      type: T.userMessage,
      payload: { content: "hello?", from: { kind: "user", origin: "web" } },
    });

    // Incarnation 1 accepts the request and hangs on the AI binding.
    const started = await h.stream.waitForEvent({ eventTypes: [T.started], timeoutMs: 5_000 });
    const inFlightRequestOffset = h.stream.events.find((e) => e.type === T.requested)!.offset;
    // In-flight work parked a durable revival alarm ahead of itself.
    expect(h.store.alarm.at).not.toBeNull();

    h.crash(); // THE DEPLOY: isolate gone, journal + checkpoint + alarm survive

    await h.advance(15_000); // the alarm fires; the whole revival pass runs live

    // The journal narrates the crash: the request that died, the revival, and
    // a cancel (not a failed llm-request-completed) for the in-flight attempt.
    const types = h.stream.events.map((event) => event.type);
    expect(types.indexOf(T.revived)).toBeGreaterThan(types.indexOf(T.started));
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
    const output = await h.stream.waitForEvent({ eventTypes: [T.output], timeoutMs: 5_000 });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("recovered!"),
      llmRequestOffset: resumedRequested.offset,
    });
  });

  it("recovers a lost debounce timer: revival re-derives the requested event from the fold", async () => {
    await h.stream.append({
      type: T.userMessage,
      payload: { content: "are you there?", from: { kind: "user", origin: "web" } },
    });
    const scheduled = await h.stream.waitForEvent({ eventTypes: [T.scheduled], timeoutMs: 5_000 });

    h.crash(); // evicted BEFORE the debounce fired; the timer is gone

    await h.advance(15_000);
    // The revival batch ran the agent's reconciliation: scheduled + no live
    // timer → requested immediately, keyed on the scheduled offset so a
    // concurrently-surviving timer could never double-fire it.
    const requested = await h.stream.waitForEvent({ eventTypes: [T.requested], timeoutMs: 5_000 });
    expect(requested.idempotencyKey).toBe(`agent/llm-request-requested@${scheduled.offset}`);

    const output = await h.stream.waitForEvent({ eventTypes: [T.output], timeoutMs: 5_000 });
    expect(output.payload).toMatchObject({
      content: expect.stringContaining("recovered!"),
    });
  });
});

describe("attempt bookkeeping under stream failures", () => {
  it("a failed started-append leaves the obligation requested and releases the live-set (no leak, retried later)", async () => {
    const stream = new MemoryStream();
    let failStartedAppends = true;
    const realAppend = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      if (
        failStartedAppends &&
        inputs.some((input) => "type" in input && input.type === T.started)
      ) {
        throw new Error("stream hiccup");
      }
      return realAppend(...inputs);
    };
    let dials = 0;
    const agent = new AgentProcessor({
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
    const [requested] = await appendTestEvents(stream, {
      type: T.requested,
      payload: { model: "gpt-test", requestId: "llm-request:gen-1" },
    });
    await agent.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The attempt died before dialing; nothing was settled, nothing leaked.
    expect(dials).toBe(0);
    expect(stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(agent.state.llmRequests[String(requested!.offset)]).toMatchObject({
      status: "requested",
    });

    // The stream recovers; the next batch's reconciliation retries the whole
    // attempt — a leaked live-set entry would make it skip this id forever.
    failStartedAppends = false;
    const [nudge] = await appendTestEvents(stream, {
      type: "events.iterate.com/test/nudge",
      payload: {},
    });
    await agent.ingest({ events: [nudge!], streamMaxOffset: nudge!.offset });
    await vi.waitFor(() => {
      const completion = stream.events.find(
        (event) =>
          event.type === T.completed &&
          (event.payload as { llmRequestOffset: number }).llmRequestOffset === requested!.offset,
      );
      expect(completion?.payload).toMatchObject({ result: { status: "success" } });
    });
    expect(dials).toBe(1);
  });
});

describe("staleness policy (only-settle-past-expiry)", () => {
  it("settles an expired request as failure without ever dialing the AI binding", async () => {
    const stream = new MemoryStream();
    const agent = new AgentProcessor({
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
    const [requested] = await appendTestEvents(stream, {
      type: T.requested,
      payload: {
        model: "gpt-test",
        requestId: "llm-request:gen-1",
        expiresAt: Date.now() - 1, // the host slept past the intent's horizon
      },
    });
    await agent.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
    await vi.waitFor(() => {
      const completion = stream.events.find((event) => event.type === T.completed);
      expect(completion?.payload).toMatchObject({
        llmRequestOffset: requested!.offset,
        result: { status: "failure", error: { message: expect.stringContaining("expired") } },
      });
    });
  });

  it("the agent's backstop settles a request that never completed", async () => {
    const stream = new MemoryStream();
    const now = Date.now();
    // Reached-by-lifecycle state, seeded as a checkpoint: a request accepted
    // long ago whose LLM attempt never finished.
    const stuck = AgentProcessorContract.stateSchema.parse({
      currentRequest: {
        phase: "requested",
        llmRequestOffset: 2,
        requestedAt: now - AGENT_LLM_REQUEST_BACKSTOP_MS - 1,
      },
    });
    const agent = new AgentProcessor({
      stream,
      path: stream.path,
      projectId: null,
      readState: () => ({ offset: 2, state: stuck }),
      now: () => now,
    });
    // The checkpoint sits at offset 2; give the journal that history so the
    // nudge lands past it instead of being filtered as already-processed.
    await stream.append(
      {
        type: T.scheduled,
        payload: { debounceMs: 0, model: "m", requestId: "r" },
      },
      { type: T.requested, payload: { model: "m", requestId: "r" } },
    );
    const [nudge] = await appendTestEvents(stream, {
      type: T.userMessage,
      payload: { content: "hello? anyone?", from: { kind: "user", origin: "web" } },
    });
    await agent.ingest({ events: [nudge!], streamMaxOffset: nudge!.offset });

    const backstop = stream.events.find((event) => event.type === T.completed);
    expect(backstop?.idempotencyKey).toBe("agent/llm-request-completed@2");
    expect(backstop?.payload).toMatchObject({
      llmRequestOffset: 2,
      result: { status: "failure", error: { message: expect.stringContaining("backstop") } },
    });
  });

  it("a request past BOTH the expiry and the backstop horizon settles exactly once", async () => {
    const stream = new MemoryStream();
    // requestedAt comes from the journaled event's wall-clock createdAt; run
    // the processor's clock far enough ahead that the expired-obligation pass
    // AND the backstop both want to settle this request in the same reconcile.
    const now = Date.now() + AGENT_LLM_REQUEST_BACKSTOP_MS + 60_000;
    const agent = new AgentProcessor({
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
    const [requested] = await appendTestEvents(stream, {
      type: T.requested,
      payload: { model: "m", requestId: "r", expiresAt: now - 1 },
    });
    await agent.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completions = stream.events.filter((event) => event.type === T.completed);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.payload).toMatchObject({
      llmRequestOffset: requested!.offset,
      result: { status: "failure" },
    });
  });
});
