// The clean-room agent processor's executable spec, on the generic step
// harness from iterate/processors/testing: the REAL StreamProcessorRunner
// over the shared MemoryStream (production idempotency semantics: a same-key
// append with a different body is REJECTED), virtual time, and
// eviction-faithful crash(). Scenarios are ordered steps — typed appends,
// advanceTime, crash, and function steps driving the scripted LLM transport
// (the only agent-specific fake, defined here).

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness, type HarnessSubstrate } from "iterate/processors/testing";
import {
  AgentNextProcessorContract,
  type AgentNextContextAddedPayload,
} from "./agent-processor-contract.ts";
import {
  AgentNextProcessor,
  buildLlmMessages,
  projectContextAdded,
  type AgentLlmMessage,
} from "./agent-processor-implementation.ts";

type AgentEventInput = ConsumedInput<AgentNextProcessorContract>;

// -----------------------------------------------------------------------------
// Event literals: the birth bundle and the recurring message shapes. These are
// event BUILDERS (data), not append wrappers — every test appends through the
// harness's typed append.
// -----------------------------------------------------------------------------

const NEW_AGENT_EVENTS = [
  { type: "events.iterate.com/agent/created", payload: {} },
  {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "test-model" } } },
  },
  {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "system",
      key: "agent/system-prompt",
      content: "You are a helpful test agent.",
    },
  },
] satisfies AgentEventInput[];

function userMessage(
  content: string,
  llmRequestPolicy?:
    | { behaviour: "after-current-request" }
    | { behaviour: "interrupt-current-request" }
    | { behaviour: "dont-trigger-request" },
): AgentEventInput {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content,
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: llmRequestPolicy ?? { behaviour: "after-current-request" },
    },
  };
}

/** A self-driven trigger (what a script/agent note does in production). */
function agentLoopNote(content: string): AgentEventInput {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "developer",
      content,
      actor: { type: "script", executionId: "agent-output:0" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

const REVIVED = {
  type: "events.iterate.com/stream/processor-revived",
  payload: { processorSlug: "agent-next", revivals: 1, version: "test" },
} satisfies AgentEventInput;

// -----------------------------------------------------------------------------
// Scripted LLM transport: every call parks until the test settles it, and the
// abort signal rejects it the way a real fetch would. `respond`/`fail` settle
// the NEWEST call; `calls[i]` gives surgical control for zombie races.
// -----------------------------------------------------------------------------

function makeScriptedLlm() {
  const calls: {
    model: string;
    messages: AgentLlmMessage[];
    onChunk?: (text: string) => void;
    signal: AbortSignal;
    resolve: (result: {
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    calls,
    respond(text: string, usage?: { inputTokens: number; outputTokens: number }) {
      calls.at(-1)!.resolve({ text, ...(usage === undefined ? {} : { usage }) });
    },
    fail(message: string) {
      calls.at(-1)!.reject(new Error(message));
    },
    transport: (args: {
      model: string;
      messages: AgentLlmMessage[];
      signal: AbortSignal;
      onChunk?: (text: string) => void;
    }) =>
      new Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>(
        (resolve, reject) => {
          args.signal.addEventListener("abort", () => reject(new Error("aborted")));
          calls.push({ ...args, resolve, reject });
        },
      ),
  };
}

/** The generic harness plus the agent's scripted LLM, wired in createProcessor. */
function makeAgentHarness(substrate?: HarnessSubstrate) {
  const llm = makeScriptedLlm();
  const harness = makeProcessorHarness<AgentNextProcessorContract>({
    createProcessor: (deps) => new AgentNextProcessor({ ...deps, callLlm: llm.transport }),
    path: "/agents/next-test",
    ...(substrate === undefined ? {} : { substrate }),
  });
  return { ...harness, llm };
}

const REQUESTED = "events.iterate.com/agent/llm-request-requested";
const SETTLED = "events.iterate.com/agent/llm-request-settled";

// =============================================================================
// The turn lifecycle
// =============================================================================

describe("AgentNextProcessor turn lifecycle", () => {
  it("runs a full turn: user message → intent → offset-identified request → atomic assistant+settled", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("Hello there")],
      ["advanceTime", 10_000], // closes the debounce window → intent lands, request adopted
    );

    // The request's identity is the offset the journal assigned the intent.
    expect(h.llm.calls).toHaveLength(1);
    const requested = h.events(REQUESTED)[0]!;
    expect(requested.idempotencyKey).toMatch(/^agent-next\/request\/\d+$/);
    expect(h.state().openRequest).toMatchObject({ requestedAtOffset: requested.offset });

    // The prompt: system slot, the user message, timestamp last.
    const call = h.llm.calls[0]!;
    expect(call.model).toBe("test-model");
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toContain("You are a helpful test agent.");
    expect(call.messages.at(-2)?.content).toContain("Hello there");
    expect(call.messages.at(-1)?.content).toMatch(/current time/);

    await h.play(() => h.llm.respond("Hi!", { inputTokens: 10, outputTokens: 2 }));

    expect(h.state().openRequest).toBeNull();
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          requestOffset: requested.offset,
          result: { status: "succeeded", text: "Hi!", usage: { inputTokens: 10, outputTokens: 2 } },
        },
      },
    ]);
    expect(h.state().contextItems.at(-1)).toMatchObject({
      payload: { role: "assistant", content: "Hi!", llmRequestOffset: requested.offset },
    });
  });

  it("debounce coalesces a burst: two inputs, ONE open request covering both", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("first")],
      ["advanceTime", 100], // inside the window — the trigger moves instead of firing
      ["append", userMessage("second")],
      ["advanceTime", 10_000],
    );

    // Exactly one request ever opened, and its prompt covers both messages
    // (any late sibling intent is a journal fact the fold ignored).
    expect(h.llm.calls).toHaveLength(1);
    const prompt = h.llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("first");
    expect(prompt).toContain("second");
    expect(h.state().openRequest).not.toBeNull();
    expect(h.state().pendingLlmRequestTrigger).toBeNull();
  });

  it("interrupt mid-flight: aborts, settles cancelled with the streamed partial; the zombie completion loses the settle race", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("Hello")],
      ["advanceTime", 10_000],
      () => {
        h.llm.calls[0]!.onChunk?.("Hel");
        h.llm.calls[0]!.onChunk?.("lo");
      },
      ["append", userMessage("actually stop", { behaviour: "interrupt-current-request" })],
    );

    expect(h.llm.calls[0]!.signal.aborted).toBe(true);
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          result: {
            status: "cancelled",
            reason: "interrupted-by-user-input",
            partialText: "Hello",
          },
        },
      },
    ]);

    // The zombie finishing anyway adds nothing: the abort guard drops it, and
    // even a raced completion loses on the shared settle key.
    await h.play(() => h.llm.respond("too late"));
    expect(h.events(SETTLED)).toHaveLength(1);
    expect(h.state().contextItems.some((item) => item.payload.content === "too late")).toBe(false);

    // The streamed partial is preserved as model-visible history WITHOUT an
    // llmRequestOffset, so script extraction can never run on a half response.
    const partialItem = h
      .state()
      .contextItems.find((item) => item.payload.content.includes("partial output follows"));
    expect(partialItem).toMatchObject({ payload: { role: "assistant" } });
    expect(partialItem!.payload).not.toHaveProperty("llmRequestOffset");
    expect(partialItem!.payload.content).toContain("Hello");

    // The interrupting input is itself the next trigger, on a NEW request that
    // sees what already streamed.
    await h.play(["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(2);
    const secondPrompt = h.llm.calls[1]!.messages.map((message) => message.content).join("\n");
    expect(secondPrompt).toContain("actually stop");
    expect(secondPrompt).toContain("Hello");
    expect(h.events(REQUESTED)).toHaveLength(2);
  });
});

// =============================================================================
// Recovery — the reason this processor exists
// =============================================================================

describe("AgentNextProcessor recovery", () => {
  it("eviction mid-debounce: the revival turn finds the window closed and journals the intent directly", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("Hello?")], // debounce sleep parked…
      ["crash"], // …and dies with the incarnation
      ["advanceTime", 60_000],
      ["append", REVIVED],
    );

    // processEvent re-ran over the fold: trigger still pending, window long
    // closed, intent appended immediately, request adopted, LLM running.
    expect(h.events(REQUESTED)).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(1);
    await h.play(() => h.llm.respond("Recovered!"));
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { result: { status: "succeeded", text: "Recovered!" } } },
    ]);
  });

  it("eviction mid-flight: the fresh incarnation adopts the SAME request and settles it once", async () => {
    const h = makeAgentHarness();
    await h.play(["append", ...NEW_AGENT_EVENTS, userMessage("Hello")], ["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(1); // the doomed attempt
    const requested = h.events(REQUESTED)[0]!;

    await h.play(["crash"], ["advanceTime", 30_000], ["append", REVIVED]);

    // No new requested event — the same journaled intent runs again.
    expect(h.events(REQUESTED)).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(2);
    await h.play(() => h.llm.respond("Adopted."));
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { requestOffset: requested.offset, result: { status: "succeeded" } } },
    ]);
    expect(h.state().openRequest).toBeNull();
  });

  it("zombie race: a presumed-dead incarnation settling after its successor loses the settle race", async () => {
    const h = makeAgentHarness();
    await h.play(["append", ...NEW_AGENT_EVENTS, userMessage("Hello")], ["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(1);

    // The old incarnation's attempt (calls[0]) survives the crash as a zombie
    // closure; the successor adopts the same request as calls[1].
    await h.play(["crash"], ["append", REVIVED]);
    expect(h.llm.calls).toHaveLength(2);

    await h.play(() => h.llm.calls[1]!.resolve({ text: "from-successor" }));
    // The zombie finishes too — same settle key, DIFFERENT body: the journal
    // rejects the batch and the successor's story stands.
    await h.play(() => h.llm.calls[0]!.resolve({ text: "from-zombie" }));

    expect(h.events(SETTLED)).toHaveLength(1);
    const assistants = h.state().contextItems.filter((item) => item.payload.role === "assistant");
    expect(assistants).toMatchObject([{ payload: { content: "from-successor" } }]);
  });

  it("an interrupt during the eviction window cancels WITHOUT adopting the request it cancels", async () => {
    const h = makeAgentHarness();
    await h.play(["append", ...NEW_AGENT_EVENTS, userMessage("Hello")], ["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(1);

    // The user interrupts before any revival. The delivery must settle the
    // request cancelled and must NOT start a doomed attempt for it in the
    // same frame (the fold it reads is pre-cancel).
    await h.play(
      ["crash"],
      ["append", userMessage("wait, stop", { behaviour: "interrupt-current-request" })],
    );
    expect(h.llm.calls).toHaveLength(1); // no new attempt
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { result: { status: "cancelled", reason: "interrupted-by-user-input" } } },
    ]);
    expect(h.state().openRequest).toBeNull();

    // The interrupting message then gets its own turn, on a NEW request.
    await h.play(["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(2);
    expect(h.llm.calls[1]!.messages.map((message) => message.content).join("\n")).toContain(
      "wait, stop",
    );
    expect(h.events(REQUESTED)).toHaveLength(2);
  });

  it("expiry: a request past its horizon settles cancelled/expired and the miss is transcribed for the model", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("Hello")],
      ["advanceTime", 10_000],
      ["crash"],
      ["advanceTime", 10 * 60_000 + 1],
      ["append", REVIVED],
    );

    expect(h.llm.calls).toHaveLength(1); // only the pre-crash attempt; never re-run
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { result: { status: "cancelled", reason: "expired" } } },
    ]);
    expect(h.state().openRequest).toBeNull();
    // The dropped turn is admitted as an error and transcribed into context,
    // so the next turn (and the user) can see what happened.
    expect(h.events("events.iterate.com/stream/error-occurred")).toMatchObject([
      { payload: { message: expect.stringContaining("expired") } },
    ]);
    expect(
      h.state().contextItems.find((item) => item.payload.content.includes("expired")),
    ).toMatchObject({ payload: { role: "developer", actor: { type: "integration" } } });
  });
});

// =============================================================================
// Failure policy — retry via the fold, errors transcribed, pause/resume
// =============================================================================

describe("AgentNextProcessor failure policy", () => {
  it("a failed request retries per the configured policy; every failure is transcribed; user input resets the streak", async () => {
    const h = makeAgentHarness();
    await h.play(
      [
        "append",
        ...NEW_AGENT_EVENTS,
        {
          type: "events.iterate.com/agent/configured",
          payload: { config: { llmRequestRetryPolicy: { maxAttempts: 2 } } },
        },
        userMessage("Hello"),
      ],
      ["advanceTime", 10_000],
      () => h.llm.fail("boom 1"),
      ["advanceTime", 120_000], // debounce + backoff → retry attempt runs
    );
    expect(h.llm.calls).toHaveLength(2);

    await h.play(() => h.llm.fail("boom 2"), ["advanceTime", 120_000]);
    // maxAttempts: 2 → no third attempt even after every window clears.
    expect(h.llm.calls).toHaveLength(2);
    expect(h.state().consecutiveLlmFailures).toBe(2);
    expect(h.state().pendingLlmRequestTrigger).toBeNull();

    // Both failures were journaled as stream errors and transcribed into
    // model-visible context without triggering turns of their own.
    expect(h.events("events.iterate.com/stream/error-occurred")).toMatchObject([
      { payload: { message: expect.stringContaining("attempt 1 of 2") } },
      { payload: { message: expect.stringContaining("Giving up") } },
    ]);
    const transcripts = h
      .state()
      .contextItems.filter((item) => item.payload.content.startsWith("Error on stream:"));
    expect(transcripts).toHaveLength(2);

    // The retry-policy patch merged into the config without disturbing the
    // earlier llm.model patch or the untouched defaults.
    expect(h.state().config).toMatchObject({
      llm: { model: "test-model" },
      llmRequestRetryPolicy: { maxAttempts: 2, backoffBaseMs: 10_000 },
    });

    // Fresh user input is a fresh start: streak reset, turns come back.
    await h.play(["append", userMessage("try again")], ["advanceTime", 10_000]);
    expect(h.llm.calls).toHaveLength(3);
    expect(h.state().consecutiveLlmFailures).toBe(0);
  });

  it("the autonomous-loop breaker journals agent/paused; the next user message journals agent/resumed", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      ...NEW_AGENT_EVENTS,
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { maxAutonomousTurns: 2 } },
      },
    ]);
    for (let turn = 0; turn < 3; turn++) {
      await h.play(
        ["append", agentLoopNote(`self-driven trigger ${turn}`)],
        ["advanceTime", 20_000],
      );
      if (h.llm.calls.length > turn) await h.play(() => h.llm.respond(`turn ${turn}`));
    }

    // Two autonomous turns ran; the third trigger tripped the breaker.
    expect(h.llm.calls).toHaveLength(2);
    expect(h.events("events.iterate.com/agent/paused")).toMatchObject([
      { payload: { reason: expect.stringContaining("autonomous turn limit") } },
    ]);
    expect(h.state().paused).not.toBeNull();
    expect(h.state().pendingLlmRequestTrigger).toBeNull();

    // A human message resumes the loop with a fresh autonomous budget.
    await h.play(["append", userMessage("are you there?")], ["advanceTime", 20_000]);
    expect(h.events("events.iterate.com/agent/resumed")).toHaveLength(1);
    expect(h.state().paused).toBeNull();
    expect(h.state().autonomousTurnCount).toBe(0);
    expect(h.llm.calls).toHaveLength(3);
  });
});

// =============================================================================
// Scripts, error transcription, config, ephemerality
// =============================================================================

describe("AgentNextProcessor script execution", () => {
  it("extracts a script from assistant output, requests the run, renders the settlement, and the result triggers the next turn", async () => {
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("How many unread emails?")],
      ["advanceTime", 10_000],
      () => h.llm.respond("Let me check.\n```ts\nasync (itx) => itx.email.unreadCount()\n```"),
    );

    const scriptRequests = h.events("events.iterate.com/capability-host/script-run-requested");
    expect(scriptRequests).toMatchObject([
      {
        payload: {
          executionId: expect.stringMatching(/^agent-output:/),
          code: expect.stringContaining("unreadCount"),
        },
      },
    ]);
    const executionId = (scriptRequests[0]!.payload as { executionId: string }).executionId;
    expect(h.state().activeScriptExecutionIds).toEqual([executionId]);

    // The capability host settles (played by the test); the rendered result is
    // an agent-loop trigger, so the next turn sees it.
    await h.play(
      [
        "append",
        {
          type: "events.iterate.com/capability-host/script-run-settled",
          payload: {
            executionId,
            settlement: { status: "succeeded", result: { unreadCount: 3 } },
          },
        },
      ],
      ["advanceTime", 10_000],
    );
    expect(h.state().activeScriptExecutionIds).toEqual([]);
    expect(h.llm.calls).toHaveLength(2);
    const prompt = h.llm.calls[1]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("unreadCount");
    expect(prompt).toContain("3");
  });
});

describe("AgentNextProcessor stream facts", () => {
  it("transcribes ANY stream/error-occurred into model-visible context without triggering a turn", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      ...NEW_AGENT_EVENTS,
      {
        type: "events.iterate.com/stream/error-occurred",
        payload: { message: 'subscription "worker" skipped poison event at offset 7' },
      },
    ]);

    expect(h.state().contextItems.at(-1)).toMatchObject({
      payload: {
        role: "developer",
        content: expect.stringContaining("skipped poison"),
        actor: { type: "integration", name: "stream-error" },
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    });
    expect(h.state().pendingLlmRequestTrigger).toBeNull();
    expect(h.llm.calls).toHaveLength(0);
  });

  it("a pause landing after an external message does NOT swallow it: the trigger survives and resumes the loop", async () => {
    // The breaker's paused append is background work: an external message can
    // land between the pause being decided and the paused event committing.
    // The fold only clears SELF-DRIVEN triggers on pause; the raced external
    // trigger survives, resumes the loop, and gets its turn.
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("am I still here?")],
      [
        "append",
        { type: "events.iterate.com/agent/paused", payload: { reason: "breaker raced the user" } },
      ],
      ["advanceTime", 10_000],
    );

    expect(h.events("events.iterate.com/agent/resumed")).toHaveLength(1);
    expect(h.state().paused).toBeNull();
    expect(h.llm.calls).toHaveLength(1);
    expect(h.llm.calls[0]!.messages.map((m) => m.content).join("\n")).toContain("am I still here?");
  });

  it("an intent landing DURING a pause burns its key harmlessly: resume re-anchors the trigger and the turn still runs", async () => {
    // The tight production race: the pause lands, the auto-resume append (a
    // droppable background attempt) fails transiently, and the parked
    // debounced intent fires while the pause still stands. The intent folds
    // to nothing but consumes the trigger-keyed request/<offset> idempotency
    // key — without re-anchoring, every post-resume re-schedule would dedupe
    // against that no-op event forever and the user message would strand.
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("still with me?")], // intent parked, window open
      () => {
        h.stream.failAppendsOfType = "events.iterate.com/agent/resumed";
      },
      ["append", { type: "events.iterate.com/agent/paused", payload: { reason: "operator" } }],
      ["advanceTime", 10_000], // the parked intent lands while paused → folds to nothing, key burned
      () => {
        h.stream.failAppendsOfType = undefined;
      },
      ["append", REVIVED], // any delivery at head: the resume attempt now succeeds
      ["advanceTime", 10_000], // the re-anchored trigger's window closes → fresh intent
    );

    expect(h.events("events.iterate.com/agent/resumed")).toHaveLength(1);
    expect(h.state().paused).toBeNull();
    // The burned no-op intent is a journal fact; the re-anchored trigger got
    // a FRESH key, so a second requested event committed and the turn ran.
    expect(h.events(REQUESTED)).toHaveLength(2);
    expect(h.state().openRequest).not.toBeNull();
    expect(h.llm.calls).toHaveLength(1);
    expect(h.llm.calls[0]!.messages.map((m) => m.content).join("\n")).toContain("still with me?");
  });

  it("re-scheduling the same trigger produces an identical intent body that dedupes on the key", async () => {
    // Every at-head delivery while the debounce window is open schedules
    // another sleep-then-append for the SAME trigger. The body is
    // deterministic (expiresAt anchors to the trigger, never `now`), so the
    // duplicates dedupe on the idempotency key instead of the journal
    // rejecting a same-key-different-body append.
    const h = makeAgentHarness();
    await h.play(
      ["append", ...NEW_AGENT_EVENTS, userMessage("hello")],
      // A non-trigger delivery inside the window: the at-head pass runs again
      // over the same pending trigger and parks a second intent append.
      [
        "append",
        {
          type: "events.iterate.com/agents/context-added",
          payload: { role: "system", content: "another system item" },
        },
      ],
      ["advanceTime", 10_000], // both parked appends fire
    );

    expect(h.events(REQUESTED)).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(1);
    const requested = h.events(REQUESTED)[0]!;
    const trigger = h.events("events.iterate.com/agents/context-added")[1]!; // the user message
    expect((requested.payload as { expiresAt: number }).expiresAt).toBe(
      Date.parse(trigger.createdAt) + h.state().config.llmRequestExpiryMs,
    );
  });

  it("agent/configured merges partial patches; omitted keys keep their values", async () => {
    const h = makeAgentHarness();
    await h.play([
      "append",
      { type: "events.iterate.com/agent/created", payload: {} },
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { model: "custom-model" }, maxAutonomousTurns: 5 } },
      },
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { llmRequestDebounceMs: 100 } },
      },
    ]);
    expect(h.state().config).toMatchObject({
      llm: { model: "custom-model" },
      maxAutonomousTurns: 5,
      llmRequestDebounceMs: 100,
      llmRequestRetryPolicy: { maxAttempts: 3 }, // untouched default
    });
  });

  it("llm-response-chunk is FORCIBLY ephemeral: absent defaults in, explicit false is rejected", () => {
    const built = AgentNextProcessorContract.buildEvent({
      type: "events.iterate.com/agent/llm-response-chunk",
      payload: { requestOffset: 1, sequence: 0, text: "hi" },
    });
    expect(built).toMatchObject({ ephemeral: true });
    expect(() =>
      AgentNextProcessorContract.buildEvent({
        type: "events.iterate.com/agent/llm-response-chunk",
        payload: { requestOffset: 1, sequence: 0, text: "hi" },
        // The envelope type already forbids `false` (`ephemeral?: true`); the
        // runtime parse must too, for untyped raw appends.
        // @ts-expect-error
        ephemeral: false,
      }),
    ).toThrow();
  });
});

// =============================================================================
// Pure helpers
// =============================================================================

describe("context projection", () => {
  const systemItem = (offset: number, content: string) => ({
    offset,
    payload: {
      role: "system",
      key: "agent/system-prompt",
      content,
      llmRequestPolicy: { behaviour: "after-current-request" },
    } as AgentNextContextAddedPayload,
  });

  it("a keyed item no request has seen is replaced in place; a covered one appends a new occurrence", () => {
    const first = projectContextAdded({
      items: [],
      lastLlmRequestOffset: 0,
      item: systemItem(1, "v1"),
    });
    const replaced = projectContextAdded({
      items: first,
      lastLlmRequestOffset: 0,
      item: systemItem(2, "v2"),
    });
    expect(replaced).toMatchObject([{ offset: 2, payload: { content: "v2" } }]);

    // A request at offset 5 has now covered the item — the next keyed update
    // appends instead of rewriting covered history.
    const updated = projectContextAdded({
      items: replaced,
      lastLlmRequestOffset: 5,
      item: systemItem(6, "v3"),
    });
    expect(updated.map((item) => item.offset)).toEqual([2, 6]);
  });

  it("buildLlmMessages pins to the request offset, keeps system items in place, demotes non-agent developer items", () => {
    const contextItems = [
      systemItem(1, "prompt"),
      {
        offset: 2,
        payload: {
          role: "developer",
          content: "from an integration",
          actor: { type: "integration", name: "slack" },
          llmRequestPolicy: { behaviour: "after-current-request" },
        } as AgentNextContextAddedPayload,
      },
      {
        offset: 9,
        payload: {
          role: "user",
          content: "arrived after the request",
          llmRequestPolicy: { behaviour: "after-current-request" },
        } as AgentNextContextAddedPayload,
      },
    ];
    const messages = buildLlmMessages({
      contextItems,
      requestedAtOffset: 4,
      nowIso: "2026-07-20T12:00:00.000Z",
    });
    // Demoted to user (trust boundary), and the offset-9 item is NOT covered.
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "developer"]);
    expect(messages.some((message) => message.content.includes("arrived after"))).toBe(false);
  });
});
