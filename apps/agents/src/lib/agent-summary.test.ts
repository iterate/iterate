import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { AgentProcessor } from "../../runtime/processor.ts";
import {
  countActiveOrWaiting,
  orderAgents,
  summarizeAgentState,
  type AgentRow,
} from "./agent-summary.ts";

const born = [
  { type: "events.iterate.com/agent/create-requested", payload: {} },
  { type: "events.iterate.com/agent/created", payload: { path: "/agents/a" } },
];
const system = {
  type: "events.iterate.com/agent/context-added",
  payload: { role: "system", content: "Be terse." },
};
const paused = { type: "events.iterate.com/agent/paused", payload: { reason: "too many turns" } };
const script = 'Checking.\n<codemode status="Looking">\nreturn 1\n</codemode>';

const summaryRows: {
  name: string;
  events: { type: string; payload?: unknown }[];
  summary: ReturnType<typeof summarizeAgentState>;
}[] = [
  {
    name: "a birth still settling is running",
    events: born.slice(0, 1),
    summary: { status: "running", lastActivityAt: at(1), title: null },
  },
  {
    name: "born and never spoken to: idle, untitled",
    events: [...born, system],
    summary: { status: "idle", lastActivityAt: at(3), title: null },
  },
  {
    name: "a person's words raise the trigger: running, titled by their first line",
    events: [...born, system, user("\n  Fix the build  \nthen ship it")],
    summary: { status: "running", lastActivityAt: at(4), title: "Fix the build" },
  },
  {
    name: "an open request is running",
    events: [...born, system, user("Hi"), llmRequested(4)],
    summary: { status: "running", lastActivityAt: at(5), title: "Hi" },
  },
  {
    name: "prose alone settles the turn: idle",
    events: [...born, system, user("Hi"), llmRequested(4), assistant("Hello.", 5), settled(5)],
    summary: { status: "idle", lastActivityAt: at(7), title: "Hi" },
  },
  {
    name: "an answer that asked for a script is running until the result comes back",
    events: [...born, system, user("Hi"), llmRequested(4), assistant(script, 5), settled(5)],
    summary: { status: "running", lastActivityAt: at(7), title: "Hi" },
  },
  {
    name: "the script's result is the next trigger: still running",
    events: [
      ...born,
      system,
      user("Hi"),
      llmRequested(4),
      assistant(script, 5),
      settled(5),
      scriptResult(6),
    ],
    summary: { status: "running", lastActivityAt: at(8), title: "Hi" },
  },
  {
    name: "a paused agent waits on a person",
    events: [...born, system, user("Hi"), paused],
    summary: { status: "waiting", lastActivityAt: at(5), title: "Hi" },
  },
  {
    name: "a pause mid-turn leaves the request open, and still reads as waiting on a person",
    events: [...born, system, user("Hi"), llmRequested(4), paused],
    summary: { status: "waiting", lastActivityAt: at(6), title: "Hi" },
  },
  {
    name: "a late intent is a harmless fact: it moves neither the state nor its time",
    events: [
      ...born,
      system,
      user("Hi"),
      llmRequested(4),
      assistant("Hello.", 5),
      settled(5),
    ].concat([llmRequested(4)]),
    summary: { status: "idle", lastActivityAt: at(7), title: "Hi" },
  },
];
for (const { name, events, summary } of summaryRows)
  test(name, () => expect(summarizeAgentState(stateAfter(events))).toEqual(summary));

test("a value that is not an agent's state has no summary", () => {
  expect(summarizeAgentState(undefined)).toBeUndefined();
  expect(summarizeAgentState({ phase: "listening" })).toBeUndefined();
});

const rows = [
  row("/agents/old", "2026-09-01T00:00:00.000Z", { lastActivityAt: "2026-09-01T00:00:01.000Z" }),
  row("/agents/just-messaged", "2026-09-02T00:00:00.000Z", {
    status: "running",
    lastActivityAt: "2026-09-24T10:00:00.000Z",
  }),
  row("/agents/connecting", "2026-09-10T00:00:00.000Z"),
  row("/agents/b-tie", "2026-09-05T00:00:00.000Z", { status: "waiting" }),
  row("/agents/a-tie", "2026-09-05T00:00:00.000Z"),
];

test("most recently active first — the last move, else the birth — the path breaking a tie", () => {
  expect(orderAgents(rows, new Set()).recent.map((item) => item.path)).toEqual([
    "/agents/just-messaged",
    "/agents/connecting",
    "/agents/a-tie",
    "/agents/b-tie",
    "/agents/old",
  ]);
});

test("pinned agents are their own list, in the same order; the rest keep theirs", () => {
  const ordered = orderAgents(rows, new Set(["/agents/old", "/agents/connecting"]));
  expect(ordered.pinned.map((item) => item.path)).toEqual(["/agents/connecting", "/agents/old"]);
  expect(ordered.recent.map((item) => item.path)).toEqual([
    "/agents/just-messaged",
    "/agents/a-tie",
    "/agents/b-tie",
  ]);
});

test("the badge counts running and waiting agents, never idle or unknown ones", () => {
  expect(countActiveOrWaiting(rows)).toBe(2);
});

/** The facet's state as its live state carries it: the real reduce over real facts, so a change to
 *  the contract that the summary misreads fails here. */
function stateAfter(events: { type: string; payload?: unknown }[]) {
  return reduceProcessor(
    new AgentProcessor({
      withItx: () => Promise.reject(new Error("the reduce reaches no itx")),
      runModel: () => Promise.reject(new Error("the reduce reaches no model transport")),
    }),
    events,
  );
}

function user(content: string) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content, actor: { type: "user" } },
  };
}
function llmRequested(triggerOffset: number) {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "m", expiresAt: 999_999, triggerOffset },
  };
}
function settled(requestOffset: number) {
  return {
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result: { status: "succeeded", text: "…" } },
  };
}
function assistant(content: string, llmRequestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "assistant", content, llmRequestOffset },
  };
}
function scriptResult(requestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content: "Your script returned: 1",
      actor: { type: "script", requestOffset },
    },
  };
}
/** The harness stamps event N at N seconds past the epoch. */
function at(offset: number) {
  return new Date(offset * 1000).toISOString();
}

function row(
  path: string,
  createdAt: string,
  summary?: Partial<NonNullable<AgentRow["summary"]>>,
): AgentRow {
  return {
    path,
    createdAt,
    summary: summary && { status: "idle", lastActivityAt: null, title: null, ...summary },
  };
}
