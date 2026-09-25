// What the sidebar says about an agent, read from the agent facet's live state (runtime/contract.ts
// `stateSchema`): whether it is working, waiting on a person, or idle; when its state last moved;
// and what it is about — the first thing a person said to it. Pure, so the ordering and the status
// are unit rows (agent-summary.test.ts); use-agent-summaries.ts keeps them live.
import { z } from "zod";
import { parseCodemodeResponse } from "../../runtime/codemode-format.ts";

/** `waiting`: paused — a breaker tripped or an operator paused it, and only a person's next words
 *  resume it. `running`: otherwise, a model request is open or about to be, a script it asked for
 *  has not come back, or its birth is still settling. `idle`: nothing owed. */
export type AgentStatus = "running" | "waiting" | "idle";

export type AgentSummary = {
  status: AgentStatus;
  /** ISO time the facet's state last moved; null until it first moves. */
  lastActivityAt: string | null;
  /** The first line of the first thing a person said to it; null until someone has. */
  title: string | null;
};

/** The slice of the facet's live state a summary reads. Parsed, not asserted: a value that is not
 *  an agent's state has no summary. */
const AgentLiveState = z.object({
  creation: z.object({ status: z.string() }).nullable(),
  paused: z.object({}).nullable(),
  openRequest: z.object({}).nullable(),
  pendingLlmRequestTrigger: z.object({}).nullable(),
  lastActivityAt: z.string().nullable(),
  contextItems: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      actor: z.object({ type: z.string() }).optional(),
      llmRequestOffset: z.number().optional(),
    }),
  ),
});

/** The summary of one agent's live state, or undefined when the value is not an agent's state. */
export function summarizeAgentState(value: unknown): AgentSummary | undefined {
  const parsed = AgentLiveState.safeParse(value);
  if (!parsed.success) return undefined;
  const state = parsed.data;
  const last = state.contextItems.at(-1);
  // The model's answer asked for a script and the context has not settled it: its result is the
  // next developer item, so while the answer is still the last item the script is running.
  const scriptRunning =
    last?.role === "assistant" &&
    last.llmRequestOffset !== undefined &&
    parseCodemodeResponse(last.content).kind === "script";
  // A pause reads first, as the conversation's header does: a pause lands mid-turn with the request
  // still open, and it is the person's move from there.
  const status: AgentStatus = state.paused
    ? "waiting"
    : state.creation?.status === "requested" ||
        state.openRequest ||
        state.pendingLlmRequestTrigger ||
        scriptRunning
      ? "running"
      : "idle";
  const first = state.contextItems.find(
    (item) => item.role === "user" && (!item.actor || item.actor.type === "user"),
  );
  const title =
    first?.content
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  return { status, lastActivityAt: state.lastActivityAt, title };
}

export type AgentRow = {
  path: string;
  createdAt: string;
  /** Undefined while its live state is connecting, or when it cannot be read. */
  summary: AgentSummary | undefined;
};

/** When an agent last did anything: its state's last move, else its birth. */
function agentActivityAt(row: AgentRow): string {
  return row.summary?.lastActivityAt || row.createdAt;
}

/** The sidebar's two lists, each most recently active first (the path breaks a tie): the agents
 *  this person pinned, then the rest. */
export function orderAgents(
  rows: readonly AgentRow[],
  pinned: ReadonlySet<string>,
): { pinned: AgentRow[]; recent: AgentRow[] } {
  const ordered = rows.toSorted(
    (left, right) =>
      agentActivityAt(right).localeCompare(agentActivityAt(left)) ||
      left.path.localeCompare(right.path),
  );
  return {
    pinned: ordered.filter((row) => pinned.has(row.path)),
    recent: ordered.filter((row) => !pinned.has(row.path)),
  };
}

/** The header badge's count: agents running, or waiting on a person. */
export function countActiveOrWaiting(rows: readonly AgentRow[]): number {
  return rows.filter((row) => row.summary && row.summary.status !== "idle").length;
}
