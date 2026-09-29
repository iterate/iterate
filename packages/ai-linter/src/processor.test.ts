import { expect, test } from "vitest";
import { AiLinterProcessor, type AiLinterState, type LintStorage } from "./processor.ts";

// The processor's queue: what a delivery queues, what an outcome settles, and the key each outcome
// is appended under. The lint itself is run.ts's (run.test.ts).

const HEAD = "a".repeat(40);
const KEY = `ai-linter/v2:acme/app#7@${HEAD}`;

test("an open head is queued with the delivery's offset; a newer head replaces it; a draft, another repository or history is not", () => {
  const processor = new AiLinterProcessor(unusedItx, memoryStorage().storage);
  // before the install marker
  expect(fold(processor, [pullRequest("opened", HEAD)])).toMatchObject({ queue: [] });
  const state = fold(processor, [
    installed(),
    pullRequest("opened", HEAD),
    pullRequest("synchronize", "b".repeat(40)),
    pullRequest("opened", HEAD, { number: 8, draft: true }),
    pullRequest("opened", HEAD, { number: 9, repository: "acme/other" }),
    pullRequest("edited", HEAD, { number: 10 }),
  ]);
  expect(state.queue.map((job) => [job.key, job.offset])).toEqual([
    [`ai-linter/v2:acme/app#7@${"b".repeat(40)}`, 3],
  ]);
});

test("the latest install marker names the repository and the model", () => {
  const processor = new AiLinterProcessor(unusedItx, memoryStorage().storage);
  const state = fold(processor, [installed({ model: "openai/no-such-model" }), installed()]);
  expect([state.repository, state.model]).toEqual(["acme/app", undefined]);
  expect(fold(processor, [installed({ model: "openai/no-such-model" })])).toMatchObject({
    model: "openai/no-such-model",
  });
});

test("a head delivered again after its outcome is queued again, and its outcome is keyed by the delivery that queued it", async () => {
  const { values, storage } = memoryStorage();
  // What an earlier run of this head remembered, and another head's.
  values.set(`remembered/${KEY}/llm/abc`, "an answer");
  values.set("remembered/ai-linter/v2:acme/app#9@x/llm/abc", "another head's");
  const processor = new AiLinterProcessor(() => pullRequestClosed, storage);
  const state = fold(processor, [
    installed(),
    pullRequest("opened", HEAD),
    { type: "ai-linter/linted", payload: { key: KEY } },
    pullRequest("converted_to_draft", HEAD, { draft: true }),
    pullRequest("ready_for_review", HEAD),
  ]);
  expect(state.queue.map((job) => [job.key, job.offset])).toEqual([[KEY, 5]]);
  const appended = await processEvent(processor, state);
  expect(appended.map((event) => [event.type, event.idempotencyKey, event.payload.status])).toEqual(
    [["ai-linter/linted", `ai-linter/${KEY}@5`, "skipped"]],
  );
  // once the head's outcome is on the log, what its lint remembered goes
  expect([...values.keys()]).toEqual(["remembered/ai-linter/v2:acme/app#9@x/llm/abc"]);
});

/** `events` folded through the reduce from the initial state, at offsets 1, 2, …, on the connection's log. */
function fold(
  processor: AiLinterProcessor,
  events: { type: string; payload: Record<string, unknown> }[],
): AiLinterState {
  let state = processor.contract.initialState();
  events.forEach((input, index) => {
    const event = {
      ...input,
      offset: index + 1,
      createdAt: new Date(0).toISOString(),
      path: "/integrations/github/c1",
      source: { origin: "/integrations/github/c1" },
    };
    state = processor.reduce({ event, state }) ?? state;
  });
  return state;
}

/** The at-head pass on `state`, its background lint awaited: what it appended. */
async function processEvent(processor: AiLinterProcessor, state: AiLinterState) {
  const appended: { type: string; payload: Record<string, unknown>; idempotencyKey?: string }[] =
    [];
  const background: Promise<unknown>[] = [];
  processor.processEvent({
    event: null,
    state,
    previousState: state,
    append: async (...events) => {
      appended.push(...(events as typeof appended)); // the processor appends only ai-linter/linted
      return [];
    },
    blockProcessorWhile: () => {},
    runInBackground: (work) => void background.push(work()),
    delivery: { caughtUp: true },
  });
  await Promise.all(background);
  return appended;
}

function installed(extra: { model?: string } = {}) {
  return { type: "ai-linter/installed", payload: { repository: "acme/app", ...extra } };
}

function pullRequest(
  action: string,
  head: string,
  options: { number?: number; draft?: boolean; repository?: string } = {},
) {
  return {
    type: "events.iterate.com/github/webhook-received",
    payload: {
      delivery: { name: "pull_request" },
      body: {
        action,
        repository: { full_name: options.repository || "acme/app" },
        pull_request: {
          number: options.number ?? 7,
          state: "open",
          draft: options.draft ?? false,
          head: { sha: head },
          base: { sha: "c".repeat(40) },
        },
      },
    },
  };
}

/** An itx whose GitHub answers that the pull request was closed: the lint skips at once. */
const pullRequestClosed = {
  fetch: async () =>
    new Response(JSON.stringify({ state: "closed", draft: false, head: { sha: HEAD } }), {
      status: 200,
    }),
  [Symbol.dispose]: () => {},
} as never; // the lint's first call is the only one this itx answers

function unusedItx(): never {
  throw new Error("the reduce reaches no itx");
}

/** A host's storage in memory, as far as the processor uses it. */
function memoryStorage() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => void values.set(key, value),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    delete: async (keys: string[]) => keys.filter((key) => values.delete(key)).length,
  };
  // DurableObjectStorage's overloads (one key or many, options) are more than a Map needs to show.
  return { values, storage: storage as unknown as LintStorage };
}
