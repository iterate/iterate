// The clean-room agent processor's executable spec: a minimal in-memory
// harness (journal + progress store + virtual clock + scripted LLM transport)
// driving the REAL StreamProcessorRunner, so framework and processor are
// proven together. Recovery scenarios are first-class: crash() abandons an
// incarnation exactly like an eviction (in-memory maps and pending closures
// die; journal and progress survive) and the revived fact's ordinary delivery
// is the only recovery mechanism, just as in production.

import { describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import {
  StreamProcessorRunner,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  type ProcessorProgress,
  type ProcessorProgressStore,
} from "iterate/processors";
import type { Stream } from "../../../itx-api.generated.ts";
import {
  AGENT_CONFIGURED,
  AGENT_CONTEXT_ADDED,
  AGENT_CREATED,
  AGENT_LLM_REQUEST_EXPIRY_MS,
  AGENT_LLM_REQUEST_REQUESTED,
  AGENT_LLM_REQUEST_SETTLED,
  AGENT_LOOP_STOPPED,
  AGENT_SCRIPT_EXECUTION_ID_PREFIX,
  AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
  SCRIPT_RUN_REQUESTED,
  SCRIPT_RUN_SETTLED,
  type AgentNextState,
  type LlmRequestUsage,
} from "./agent-processor-contract.ts";
import {
  AgentNextProcessor,
  buildLlmMessages,
  projectContextAdded,
  type AgentLlmMessage,
} from "./agent-processor-implementation.ts";

const HOME = "/agents/next-test";

// -----------------------------------------------------------------------------
// In-memory journal: offset assignment, idempotency dedupe, ephemeral rows
// excluded from reads (like the real stream), createdAt from the shared
// virtual clock so debounce windows are deterministic.
// -----------------------------------------------------------------------------

type Clock = { now: number };

function makeJournal(clock: Clock, homePath = HOME) {
  const rowsByPath = new Map<string, StreamEvent[]>();
  const rowsFor = (path: string): StreamEvent[] => {
    let rows = rowsByPath.get(path);
    if (rows === undefined) {
      rows = [];
      rowsByPath.set(path, rows);
    }
    return rows;
  };

  const commit = (path: string, event: StreamEventInput): StreamEvent => {
    const rows = rowsFor(path);
    if (event.idempotencyKey !== undefined) {
      const existing = rows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing !== undefined) return existing;
    }
    const committed = {
      ...event,
      offset: (rows.at(-1)?.offset ?? 0) + 1,
      createdAt: new Date(clock.now).toISOString(),
      path,
    } as StreamEvent;
    rows.push(committed);
    return committed;
  };

  const streamAt = (path: string): Stream =>
    ({
      append: (...events: StreamEventInput[]) =>
        Promise.resolve(events.map((event) => commit(path, event))),
      at: (child: string) => streamAt(child),
      readEvents: (args?: { afterOffset?: number; limit?: number }) => {
        let cursor = args?.afterOffset ?? 0;
        const limit = args?.limit ?? 500;
        return {
          next: () => {
            const page = rowsFor(path)
              .filter((row) => row.offset > cursor && row.ephemeral !== true)
              .slice(0, limit);
            if (page.length > 0) cursor = page.at(-1)!.offset;
            return Promise.resolve(page);
          },
          [Symbol.dispose]: () => {},
        };
      },
    }) as unknown as Stream;

  return {
    stream: streamAt(homePath),
    rows: (path = homePath) => rowsFor(path),
    ofType: (type: string) => rowsFor(homePath).filter((row) => row.type === type),
    head: () => rowsFor(homePath).at(-1)?.offset ?? 0,
    append: (event: StreamEventInput) => commit(homePath, event),
  };
}
type Journal = ReturnType<typeof makeJournal>;

function makeProgressStore() {
  let record: ProcessorProgress<AgentNextState> | undefined;
  const store: ProcessorProgressStore<AgentNextState> = {
    read: () => (record === undefined ? undefined : structuredClone(record)),
    commit: (progress, opts) => {
      const persisted = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persisted) {
        throw new Error(`progress commit fenced: ${opts.expectedCursorRevision} != ${persisted}`);
      }
      record = structuredClone(progress);
    },
  };
  return {
    store,
    get record() {
      return record;
    },
  };
}

// -----------------------------------------------------------------------------
// Scripted LLM transport: every call parks until the test resolves it, and the
// abort signal rejects it the way a real fetch would.
// -----------------------------------------------------------------------------

function makeFakeLlm() {
  const calls: {
    model: string;
    messages: AgentLlmMessage[];
    onChunk?: (text: string) => void;
    signal: AbortSignal;
    resolve: (result: { text: string; usage?: LlmRequestUsage }) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    calls,
    transport: (args: {
      model: string;
      messages: AgentLlmMessage[];
      signal: AbortSignal;
      onChunk?: (text: string) => void;
    }) =>
      new Promise<{ text: string; usage?: LlmRequestUsage }>((resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(new Error("aborted")));
        calls.push({ ...args, resolve, reject });
      }),
  };
}

// -----------------------------------------------------------------------------
// Harness: one incarnation over a shared journal/store/clock. crash() disposes
// it and builds a fresh incarnation over the SAME durable substrate.
// -----------------------------------------------------------------------------

type Substrate = { clock: Clock; journal: Journal; store: ReturnType<typeof makeProgressStore> };

function makeHarness(substrate?: Substrate, opts?: { maxAutonomousTurns?: number }) {
  const clock = substrate?.clock ?? { now: 1_000_000 };
  const journal = substrate?.journal ?? makeJournal(clock);
  const store = substrate?.store ?? makeProgressStore();
  const llm = makeFakeLlm();
  const pendingSleeps: { ms: number; resolve: () => void }[] = [];
  const processor = new AgentNextProcessor({
    stream: journal.stream,
    path: HOME,
    projectId: "proj_test",
    callLlm: llm.transport,
    now: () => clock.now,
    sleep: (ms) => new Promise<void>((resolve) => pendingSleeps.push({ ms, resolve })),
    ...(opts?.maxAutonomousTurns === undefined
      ? {}
      : { maxAutonomousTurns: opts.maxAutonomousTurns }),
  });
  const runner = new StreamProcessorRunner({
    processor,
    stream: journal.stream,
    durability: { progress: store.store },
    now: () => clock.now,
    readPageSize: 5,
  });

  const harness = {
    clock,
    journal,
    store,
    llm,
    runner,
    substrate: { clock, journal, store } as Substrate,
    /** Drive delivery to a fixpoint. One runner.catchUp() pass stops at the
     * head it observed when it began; work appended DURING its final frame
     * (an intent, a settlement render) lands after that head. Production's
     * trailing self-pull re-drives in exactly this way — the loop mirrors it. */
    catchUp: async () => {
      for (let head = -1; head !== journal.head(); ) {
        head = journal.head();
        await runner.catchUp();
      }
    },
    state: async () => (await runner.snapshot()).state,
    /** Seed birth: created + configured + the canonical system prompt slot. */
    seedBirth(model = "test-model") {
      journal.append({ type: AGENT_CREATED, payload: {} });
      journal.append({ type: AGENT_CONFIGURED, payload: { config: { llm: { model } } } });
      journal.append({
        type: AGENT_CONTEXT_ADDED,
        payload: {
          role: "system",
          key: AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
          content: "You are a helpful test agent.",
        },
      });
    },
    appendUser(content: string, behaviour?: "interrupt-current-request") {
      return journal.append({
        type: AGENT_CONTEXT_ADDED,
        payload: {
          role: "user",
          content,
          actor: { type: "user", origin: "web" },
          llmRequestPolicy: { behaviour: behaviour ?? "after-current-request" },
        },
      });
    },
    /** A self-driven trigger (what a script/agent note does in production). */
    appendAgentLoopNote(content: string) {
      return journal.append({
        type: AGENT_CONTEXT_ADDED,
        payload: {
          role: "developer",
          content,
          actor: { type: "script", executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}0` },
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      });
    },
    appendRevived() {
      return journal.append({
        type: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
        payload: { processorSlug: "agent-next", revivals: 1, version: "test" },
      });
    },
    /** Close any open debounce window: advance the clock past the longest
     * pending sleep and release them all, then deliver what they appended. */
    async flushDebounce() {
      const sleeps = pendingSleeps.splice(0);
      clock.now += Math.max(0, ...sleeps.map((sleep) => sleep.ms)) + 1;
      for (const sleep of sleeps) sleep.resolve();
      // The released closures append in the background; wait for them to land.
      await Promise.resolve();
      await Promise.resolve();
      await runner.catchUp();
    },
    /** Abandon this incarnation like an eviction: runtime maps and pending
     * closures die; journal, progress, and clock survive into the successor. */
    crash() {
      runner.dispose();
      return makeHarness({ clock, journal, store }, opts);
    },
  };
  return harness;
}

/** Run seedBirth + one user message all the way to the parked LLM call. */
async function startTurn(harness: ReturnType<typeof makeHarness>, message = "Hello") {
  harness.seedBirth();
  harness.appendUser(message);
  harness.clock.now += 10_000; // window long closed → intent appends synchronously
  await harness.catchUp();
  expect(harness.llm.calls).toHaveLength(1);
  return harness.journal.ofType(AGENT_LLM_REQUEST_REQUESTED)[0]!;
}

const settledResults = (journal: Journal) =>
  journal.ofType(AGENT_LLM_REQUEST_SETTLED).map((row) => (row.payload as any).result);

// =============================================================================
// The turn lifecycle
// =============================================================================

describe("AgentNextProcessor turn lifecycle", () => {
  it("runs a full turn: user message → intent → offset-identified request → atomic assistant+settled", async () => {
    const h = makeHarness();
    const requested = await startTurn(h, "Hello there");

    // The request's identity is the offset the journal assigned the intent.
    expect(requested.idempotencyKey).toMatch(/^agent-next\/request\/\d+$/);
    const state = await h.state();
    expect(state.openRequest?.requestedAtOffset).toBe(requested.offset);

    // The prompt: system slot, the user message, timestamp last.
    const call = h.llm.calls[0]!;
    expect(call.model).toBe("test-model");
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful test agent.",
    });
    expect(call.messages.at(-2)?.content).toContain("Hello there");
    expect(call.messages.at(-1)?.content).toMatch(/current time/);

    call.resolve({ text: "Hi!", usage: { inputTokens: 10, outputTokens: 2 } });
    await vi.waitFor(() => expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1));
    await h.catchUp();

    const settled = await h.state();
    expect(settled.openRequest).toBeNull();
    expect(settledResults(h.journal)).toEqual([
      { status: "succeeded", text: "Hi!", usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    const assistant = settled.context.history.at(-1)!;
    expect(assistant.payload).toMatchObject({
      role: "assistant",
      content: "Hi!",
      llmRequestOffset: requested.offset,
    });
  });

  it("debounce coalesces a burst: two inputs, ONE open request covering both; the late intent folds to nothing", async () => {
    const h = makeHarness();
    h.seedBirth();
    h.appendUser("first");
    await h.catchUp(); // window open → delayed intent parked
    h.clock.now += 100;
    h.appendUser("second");
    await h.catchUp(); // desire moved to the second input; another intent parked

    await h.flushDebounce();

    // Both parked intents fired; the first to commit won the fold, the other
    // is a journal fact the fold ignored — exactly one request ever opened.
    expect(h.llm.calls).toHaveLength(1);
    const prompt = h.llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("first");
    expect(prompt).toContain("second");
    const state = await h.state();
    expect(state.openRequest).not.toBeNull();
    expect(state.wantsTurnSince).toBeNull();
  });

  it("interrupt mid-flight: aborts, settles cancelled with the streamed partial text; the zombie completion collapses", async () => {
    const h = makeHarness();
    const requested = await startTurn(h);
    const call = h.llm.calls[0]!;
    call.onChunk?.("Hel");
    call.onChunk?.("lo");

    h.appendUser("actually stop", "interrupt-current-request");
    await h.catchUp();

    expect(call.signal.aborted).toBe(true);
    expect(settledResults(h.journal)).toEqual([
      {
        status: "cancelled",
        reason: "interrupted-by-user-input",
        partialText: "Hello",
      },
    ]);

    // The zombie finishing anyway adds nothing: the abort guard drops it, and
    // even a raced success would dedupe on the shared settle key.
    call.resolve({ text: "too late" });
    await h.catchUp();
    expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1);
    const state = await h.state();
    expect(state.openRequest).toBeNull();
    expect(state.context.history.some((item) => item.payload.content === "too late")).toBe(false);

    // The interrupting input is itself the next trigger; its debounce window
    // opened during delivery, so release it.
    expect(state.wantsTurnSince).not.toBeNull();
    await h.flushDebounce();
    expect(h.llm.calls).toHaveLength(2);
    expect(h.llm.calls[1]!.messages.map((m) => m.content).join("\n")).toContain("actually stop");
    // The new request has a NEW offset; the cancelled one stays settled.
    expect(h.journal.ofType(AGENT_LLM_REQUEST_REQUESTED).at(-1)!.offset).toBeGreaterThan(
      requested.offset,
    );
  });
});

// =============================================================================
// Recovery — the reason this processor exists
// =============================================================================

describe("AgentNextProcessor recovery", () => {
  it("eviction mid-debounce: the revival turn finds the window closed and journals the intent directly", async () => {
    let h = makeHarness();
    h.seedBirth();
    h.appendUser("Hello?");
    await h.catchUp(); // delayed intent parked in THIS incarnation
    h = h.crash(); // …and dies with it

    h.clock.now += 60_000;
    h.appendRevived();
    await h.catchUp();

    // The drive re-ran over the fold: desire still open, window long closed,
    // intent appended synchronously, request adopted, LLM running.
    expect(h.journal.ofType(AGENT_LLM_REQUEST_REQUESTED)).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(1);
    h.llm.calls[0]!.resolve({ text: "Recovered!" });
    await vi.waitFor(() =>
      expect(settledResults(h.journal)).toEqual([expect.objectContaining({ status: "succeeded" })]),
    );
  });

  it("eviction mid-flight: the fresh incarnation adopts the SAME request and settles it once", async () => {
    let h = makeHarness();
    const requested = await startTurn(h);
    h = h.crash(); // attempt lost with the incarnation; the intent survives

    h.clock.now += 30_000;
    h.appendRevived();
    await h.catchUp();

    // No new requested event — the same journaled intent runs again.
    expect(h.journal.ofType(AGENT_LLM_REQUEST_REQUESTED)).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(1);
    h.llm.calls[0]!.resolve({ text: "Adopted." });
    await vi.waitFor(() => expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1));
    expect((h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)[0]!.payload as any).requestOffset).toBe(
      requested.offset,
    );
    await h.catchUp();
    expect((await h.state()).openRequest).toBeNull();
  });

  it("zombie race: a presumed-dead incarnation settling after its successor collapses on the settle key", async () => {
    const h1 = makeHarness();
    await startTurn(h1);
    // A second incarnation adopts over the same journal while h1 still lives
    // (imperfect eviction detection — both believe they own the request).
    const h2 = makeHarness(h1.substrate);
    h2.appendRevived();
    await h2.catchUp();
    expect(h2.llm.calls).toHaveLength(1);

    h2.llm.calls[0]!.resolve({ text: "from-successor" });
    await vi.waitFor(() => expect(h2.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1));
    // The zombie finishes too — same assistant-context and settle keys, so
    // the journal takes exactly one story.
    h1.llm.calls[0]!.resolve({ text: "from-zombie" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h2.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1);
    await h2.catchUp();
    const state = await h2.runner.snapshot();
    const assistantItems = state.state.context.history.filter(
      (item) => item.payload.role === "assistant",
    );
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]!.payload.content).toBe("from-successor");
  });

  it("expiry: a request past its horizon settles cancelled/expired instead of running", async () => {
    let h = makeHarness();
    await startTurn(h);
    h = h.crash();

    h.clock.now += AGENT_LLM_REQUEST_EXPIRY_MS + 1;
    h.appendRevived();
    await h.catchUp();

    expect(h.llm.calls).toHaveLength(0); // never ran
    expect(settledResults(h.journal)).toEqual([{ status: "cancelled", reason: "expired" }]);
    expect((await h.state()).openRequest).toBeNull();
  });
});

// =============================================================================
// Failure policy — retries, backoff, caps, loop breaker: all user space
// =============================================================================

describe("AgentNextProcessor failure policy", () => {
  it("a failed request renders a retrying note that triggers the next turn; the cap ends the chain", async () => {
    const h = makeHarness();
    await startTurn(h);
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.llm.calls[attempt - 1]!.reject(new Error(`boom ${attempt}`));
      await vi.waitFor(() =>
        expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(attempt),
      );
      await h.catchUp(); // folds the failure, renders the note, parks the retry intent
      if (attempt < 3) {
        await h.flushDebounce(); // backoff window → next attempt
        expect(h.llm.calls).toHaveLength(attempt + 1);
      }
    }
    // Third consecutive failure hits the cap: the note informs without
    // triggering, so no fourth call even after every window clears.
    await h.flushDebounce();
    expect(h.llm.calls).toHaveLength(3);
    const notes = (await h.state()).context.history.filter(
      (item) => item.payload.role === "developer",
    );
    expect(notes.at(-1)!.payload.content).toContain("Giving up");
    expect((await h.state()).consecutiveLlmFailures).toBe(3);
  });

  it("the autonomous-loop breaker stops self-driven chains with a journaled fact", async () => {
    const h = makeHarness(undefined, { maxAutonomousTurns: 2 });
    h.seedBirth();
    for (let turn = 0; turn < 3; turn++) {
      h.appendAgentLoopNote(`self-driven trigger ${turn}`);
      h.clock.now += 20_000;
      await h.catchUp();
      if (h.llm.calls.length > turn) {
        h.llm.calls[turn]!.resolve({ text: `turn ${turn}` });
        await vi.waitFor(() =>
          expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(turn + 1),
        );
        await h.catchUp();
      }
    }
    // Two autonomous turns ran; the third trigger hit the breaker.
    expect(h.llm.calls).toHaveLength(2);
    expect(h.journal.ofType(AGENT_LOOP_STOPPED)).toHaveLength(1);
    const state = await h.state();
    expect(state.wantsTurnSince).toBeNull();
    // A human message resets the count and turns come back.
    h.appendUser("are you there?");
    h.clock.now += 20_000;
    await h.catchUp();
    expect(h.llm.calls).toHaveLength(3);
  });
});

// =============================================================================
// Scripts — response parsing → capability host → result renders → next turn
// =============================================================================

describe("AgentNextProcessor script execution", () => {
  it("extracts a script from assistant output, requests the run, renders the settlement, and the result triggers the next turn", async () => {
    const h = makeHarness();
    await startTurn(h, "How many unread emails?");
    h.llm.calls[0]!.resolve({
      text: "Let me check.\n```ts\nasync (itx) => itx.email.unreadCount()\n```",
    });
    await vi.waitFor(() => expect(h.journal.ofType(AGENT_LLM_REQUEST_SETTLED)).toHaveLength(1));
    await h.catchUp(); // folds assistant output → extracts and requests the script

    const scriptRequests = h.journal.ofType(SCRIPT_RUN_REQUESTED);
    expect(scriptRequests).toHaveLength(1);
    const { executionId, code } = scriptRequests[0]!.payload as any;
    expect(executionId).toMatch(new RegExp(`^${AGENT_SCRIPT_EXECUTION_ID_PREFIX}`));
    expect(code).toContain("unreadCount");
    expect((await h.state()).activeScriptExecutionIds).toEqual([executionId]);

    // The capability host settles (played by the harness).
    h.journal.append({
      type: SCRIPT_RUN_SETTLED,
      payload: { executionId, settlement: { status: "succeeded", result: { unreadCount: 3 } } },
    });
    await h.catchUp(); // delivers the settlement, renders the result (window opens)
    await h.flushDebounce();

    // The rendered result is an agent-loop trigger: the next turn sees it.
    expect((await h.state()).activeScriptExecutionIds).toEqual([]);
    expect(h.llm.calls).toHaveLength(2);
    const prompt = h.llm.calls[1]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("unreadCount");
    expect(prompt).toContain("3");
  });
});

// =============================================================================
// Pure helpers
// =============================================================================

describe("context projection", () => {
  const empty = { system: [], history: [], publishedThrough: 0 };
  const systemItem = (offset: number, content: string) => ({
    offset,
    payload: {
      role: "system" as const,
      key: AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
      content,
    },
  });

  it("a keyed item replaces its unpublished slot in place; once published it appends with a back-reference", () => {
    const first = projectContextAdded(empty, systemItem(1, "v1"));
    const replaced = projectContextAdded(first, systemItem(2, "v2"));
    expect(replaced.system).toEqual([
      { offset: 2, payload: expect.objectContaining({ content: "v2" }) },
    ]);

    const published = { ...replaced, publishedThrough: 5 };
    const updated = projectContextAdded(published, systemItem(6, "v3"));
    expect(updated.system.map((item) => item.offset)).toEqual([2, 6]);
    expect(updated.system[1]!.updatesOffset).toBe(2);
  });

  it("buildLlmMessages pins to the request offset and demotes non-agent developer items to user role", () => {
    const context = {
      system: [systemItem(1, "prompt")],
      history: [
        {
          offset: 2,
          payload: {
            role: "developer" as const,
            content: "from an integration",
            actor: { type: "integration" as const, name: "slack" },
            llmRequestPolicy: { behaviour: "after-current-request" as const },
          },
        },
        {
          offset: 9,
          payload: { role: "user" as const, content: "arrived after the request" },
        },
      ],
      publishedThrough: 4,
    };
    const messages = buildLlmMessages({
      context: context as AgentNextState["context"],
      requestedAtOffset: 4,
      nowIso: "2026-07-20T12:00:00.000Z",
    });
    // Demoted to user (trust boundary), and the offset-9 item is NOT covered.
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "developer"]);
    expect(messages.some((message) => message.content.includes("arrived after"))).toBe(false);
  });
});
