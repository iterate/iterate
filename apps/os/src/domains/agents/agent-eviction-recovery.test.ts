// The flagship recovery scenarios: REAL host (keepalive, alarm, revival) +
// REAL agent and provider processors in plain node, with eviction as a
// first-class operator. These are the tests the 2026-06-10 and 2026-07-07
// prd incidents never had — a deploy mid-LLM-call, a lost debounce timer, a
// stale request delivered a week late — each expressed in a few lines against
// the harness (../streams/test-helpers.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProcessorHostHarness,
  MemoryStream,
  type ProcessorHostHarness,
} from "../streams/test-helpers.ts";
import { PROCESSOR_HOST_REVIVED_EVENT_TYPE } from "../streams/stream-processor-host.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { OpenAiWsProcessor } from "./openai-ws-processor-implementation.ts";
import {
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
} from "./agent-processor-contract.ts";
import { fakeResponsesWebSocket } from "./test-helpers.ts";

const T = {
  userMessage: "events.iterate.com/agents/user-message-received",
  scheduled: "events.iterate.com/agent/llm-request-scheduled",
  requested: "events.iterate.com/agent/llm-request-requested",
  started: "events.iterate.com/openai-ws/llm-request-started",
  completed: "events.iterate.com/agent/llm-request-completed",
  output: "events.iterate.com/agent/output-added",
  revived: PROCESSOR_HOST_REVIVED_EVENT_TYPE,
} as const;

function agentHarness() {
  return createProcessorHostHarness({
    build: (host, ctx) => {
      const agent = host.add((deps) => new AgentProcessor({ ...deps, now: () => ctx.clock.now }));
      const openAiWs = host.add(
        (deps) =>
          new OpenAiWsProcessor({
            ...deps,
            apiKey: "sk-test",
            now: () => ctx.clock.now,
            // Incarnation 1's vendor hangs after accepting the request — the
            // request an eviction kills mid-flight. Incarnation 2 answers.
            createResponsesWebSocketClient: async () =>
              ctx.incarnation === 1
                ? fakeResponsesWebSocket(() => [])
                : fakeResponsesWebSocket(() => [
                    { type: "response.output_text.delta", delta: "recovered!" },
                    { type: "response.completed", response: { id: "resp-2" } },
                  ]),
            readStreamEvents: () => ctx.stream.getEvents(),
          }),
      );
      return { agent, openAiWs };
    },
  });
}

describe("eviction recovery, end to end", () => {
  // The pump plays the spine's delivery role: pull-deliver on a short real
  // interval while virtual time drives alarms/expiry. catchUp is serialized
  // and offset-deduped, so overlapping pumps are safe.
  let pump: ReturnType<typeof setInterval>;
  let h: ProcessorHostHarness<{ agent: AgentProcessor; openAiWs: OpenAiWsProcessor }>;
  beforeEach(async () => {
    h = agentHarness();
    pump = setInterval(() => void h.deliverAll(), 10);
    await h.stream.append({
      type: "events.iterate.com/agent/llm-provider-selected",
      payload: { model: "gpt-test", provider: "openai-ws" },
    });
  });
  afterEach(() => {
    clearInterval(pump);
  });

  it("recovers a deploy mid-LLM-call: alarm → revival fact → orphan settled → agent retries → reply", async () => {
    await h.stream.append({
      type: T.userMessage,
      payload: { origin: "web", content: "hello?" },
    });

    // Incarnation 1 accepts the request and hangs on the vendor socket.
    const started = await h.stream.waitForEvent({ eventTypes: [T.started], timeoutMs: 5_000 });
    // In-flight work parked a durable revival alarm ahead of itself.
    expect(h.store.alarm.at).not.toBeNull();

    h.crash(); // THE DEPLOY: isolate gone, journal + checkpoint + alarm survive

    await h.advance(15_000); // the alarm fires; the whole revival pass runs live

    // The recovered turn completes: incarnation 2's vendor answers.
    const output = await h.stream.waitForEvent({ eventTypes: [T.output], timeoutMs: 5_000 });
    expect(output.payload).toMatchObject({ content: "recovered!" });
    await h.stream.waitForEvent({
      eventTypes: [T.completed],
      predicate: (event) =>
        (event.payload as { result: { status: string } }).result.status === "success",
      timeoutMs: 5_000,
    });

    // The journal narrates the whole episode, in order: the request that
    // died, the revival, its orphan settlement, and the retried request.
    const types = h.stream.events.map((event) => event.type);
    expect(types.indexOf(T.revived)).toBeGreaterThan(types.indexOf(T.started));
    const orphanCompletion = h.stream.events.find(
      (event) =>
        event.type === T.completed &&
        (event.payload as { llmRequestId: number }).llmRequestId ===
          h.stream.events.find((e) => e.type === T.requested)!.offset,
    );
    expect(orphanCompletion!.payload).toMatchObject({
      result: { status: "failure", error: { message: expect.stringContaining("orphaned") } },
    });
    expect(types.indexOf(T.output)).toBeGreaterThan(types.indexOf(T.revived));

    // Exactly one reply and one success: the dead incarnation's attempt
    // produced nothing (its vendor hung; any late write would have hit the
    // incarnation fence), and the recovered attempt ran exactly once.
    expect(types.filter((type) => type === T.output)).toHaveLength(1);
    expect(
      h.stream.events.filter(
        (event) =>
          event.type === T.completed &&
          (event.payload as { result: { status: string } }).result.status === "success",
      ),
    ).toHaveLength(1);
    expect(started).toBeDefined();
  });

  it("recovers a lost debounce timer: revival re-derives the requested event from the fold", async () => {
    await h.stream.append({
      type: T.userMessage,
      payload: { origin: "web", content: "are you there?" },
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
    expect(output.payload).toMatchObject({ content: "recovered!" });
  });
});

describe("attempt bookkeeping under stream failures", () => {
  it("a failed started-append leaves the obligation requested and releases the live-set (no leak, retried later)", async () => {
    const stream = new MemoryStream();
    let failStartedAppends = true;
    const realAppend = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      if (failStartedAppends && inputs.some((input) => input.type === T.started)) {
        throw new Error("stream hiccup");
      }
      return realAppend(...inputs);
    };
    let dials = 0;
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        dials += 1;
        return fakeResponsesWebSocket(() => [
          { type: "response.output_text.delta", delta: "late but fine" },
          { type: "response.completed", response: { id: "resp-1" } },
        ]);
      },
      readStreamEvents: () => stream.getEvents(),
      now: () => Date.now(),
    });
    const [requested] = await realAppend({
      type: T.requested,
      payload: { model: "gpt-test", provider: "openai-ws", requestId: "llm-request:gen-1" },
    });
    await openAiWs.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The attempt died before dialing; nothing was settled, nothing leaked.
    expect(dials).toBe(0);
    expect(stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(openAiWs.state.requests[String(requested!.offset)]).toMatchObject({
      status: "requested",
    });

    // The stream recovers; the next batch's reconciliation retries the whole
    // attempt — a leaked live-set entry would make it skip this id forever.
    failStartedAppends = false;
    const [nudge] = await realAppend({ type: "events.iterate.com/test/nudge", payload: {} });
    await openAiWs.ingest({ events: [nudge!], streamMaxOffset: nudge!.offset });
    await vi.waitFor(() => {
      const completion = stream.events.find(
        (event) =>
          event.type === T.completed &&
          (event.payload as { llmRequestId: number }).llmRequestId === requested!.offset,
      );
      expect(completion?.payload).toMatchObject({ result: { status: "success" } });
    });
    expect(dials).toBe(1);
  });
});

describe("staleness policy (only-settle-past-expiry)", () => {
  it("settles an expired request as failure without ever dialing the vendor", async () => {
    const stream = new MemoryStream();
    const openAiWs = new OpenAiWsProcessor({
      stream,
      apiKey: "sk-test",
      createResponsesWebSocketClient: async () => {
        throw new Error("must not dial for expired intent");
      },
      readStreamEvents: () => stream.getEvents(),
      now: () => Date.now(),
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: {
        model: "gpt-test",
        provider: "openai-ws",
        requestId: "llm-request:gen-1",
        expiresAt: Date.now() - 1, // the host slept past the intent's horizon
      },
    });
    await openAiWs.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
    await vi.waitFor(() => {
      const completion = stream.events.find((event) => event.type === T.completed);
      expect(completion?.payload).toMatchObject({
        llmRequestId: requested!.offset,
        result: { status: "failure", error: { message: expect.stringContaining("expired") } },
      });
    });
  });

  it("the agent's backstop settles a request no provider ever answered", async () => {
    const stream = new MemoryStream();
    const now = Date.now();
    // Reached-by-lifecycle state, seeded as a checkpoint: a request accepted
    // long ago whose provider layer is entirely absent (no provider processor
    // is even registered in this test — that IS the failure being modeled).
    const stuck = AgentProcessorContract.stateSchema.parse({
      currentRequest: {
        phase: "requested",
        llmRequestId: 2,
        requestedAt: now - AGENT_LLM_REQUEST_BACKSTOP_MS - 1,
      },
    });
    const agent = new AgentProcessor({
      stream,
      readState: () => ({ offset: 2, state: stuck }),
      now: () => now,
    });
    // The checkpoint sits at offset 2; give the journal that history so the
    // nudge lands past it instead of being filtered as already-processed.
    await stream.append(
      {
        type: T.scheduled,
        payload: { debounceMs: 0, model: "m", provider: "openai-ws", requestId: "r" },
      },
      { type: T.requested, payload: { model: "m", provider: "openai-ws", requestId: "r" } },
    );
    const [nudge] = await stream.append({
      type: T.userMessage,
      payload: { origin: "web", content: "hello? anyone?" },
    });
    await agent.ingest({ events: [nudge!], streamMaxOffset: nudge!.offset });

    const backstop = stream.events.find((event) => event.type === T.completed);
    expect(backstop?.idempotencyKey).toBe("agent/backstop-completed@2");
    expect(backstop?.payload).toMatchObject({
      llmRequestId: 2,
      result: { status: "failure", error: { message: expect.stringContaining("backstop") } },
    });
  });
});
