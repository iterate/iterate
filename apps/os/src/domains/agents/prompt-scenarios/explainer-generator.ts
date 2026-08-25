// Generates explainers/prompt-sections.html from the scenario fixtures: a
// static shell (explainer-shell.html — header, opinion box, vocabulary
// tables, appendices, and the thin renderer script) plus one embedded JSON
// payload derived here. Everything interactive on the page is a lookup over
// this payload: every event card carries the request-so-far AS OF that event
// (computed by the real fold; at a requested offset it is byte-identical to
// the fixture's pinned request fence, woven comments included), and the
// per-event scheduling notes come from the real fold's reduced state
// (pending trigger + debounce config). prompt-scenarios.test.ts owns
// freshness: `-u` writes the page, plain runs assert the committed page
// matches.
import fs from "node:fs";
import path from "node:path";
import { reduceAgentEvents } from "../agent-prompt-fold.ts";
import {
  computeScenarioOutputs,
  formatElapsed,
  parseElapsed,
  renderChainSnapshotLines,
  SCENARIO_TIME_ZERO,
  scenarioDir,
  synthesizeEvents,
  yamlifyValue,
  type LoadedScenario,
  type ScenarioEntry,
} from "./fixture-helpers.ts";

export const explainerPath = path.resolve(
  scenarioDir,
  "../../../../../..",
  "explainers/prompt-sections.html",
);
const shellPath = path.join(scenarioDir, "explainer-shell.html");
const DATA_PLACEHOLDER = "__SCENARIO_DATA_JSON__";

export function generateExplainerHtml(scenarios: LoadedScenario[]): string {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const data = {
    scenarios: scenarios.map((scenario) => renderScenarioData(scenario, byId)),
  };
  const shell = fs.readFileSync(shellPath, "utf8");
  if (!shell.includes(DATA_PLACEHOLDER)) {
    throw new Error(`explainer-shell.html is missing the ${DATA_PLACEHOLDER} placeholder`);
  }
  // Compact JSON — the fixtures are the human-readable source, the blob is
  // page payload. "</" escaped as the JSON-legal "<\/" so no content string
  // can terminate the embedding <script> element early. The replacement is a
  // function so `$` sequences inside the JSON stay literal ($$, $&, $' are
  // replacement patterns in a string replacement).
  const json = JSON.stringify(data).replaceAll("</", "<\\/");
  return shell.replace(DATA_PLACEHOLDER, () => json);
}

/** Every llm-request-requested event in a scenario's chain, tagged with the
 * scenario that OWNS its pinned render (the one whose fixture holds the
 * output fence). */
function chainRequests(
  scenario: LoadedScenario,
  byId: Map<string, LoadedScenario>,
): { offset: number; tMs: number; owner: LoadedScenario; model: string }[] {
  const own = scenario.entries
    .filter((entry) => entry.type === "agent/llm-request-requested")
    .map((entry) => ({
      offset: entry.off,
      tMs: parseElapsed(entry.t),
      owner: scenario,
      model: (entry.payload as any).model as string,
    }));
  if (scenario.base === null) return own;
  return [...chainRequests(byId.get(scenario.base)!, byId), ...own];
}

/**
 * The display text of the request-so-far at every chain entry, aligned with
 * `scenario.chainEntries`. At a requested offset this is the fixture's pinned
 * fence content — the same computation the fixture test asserts, ✂ line and
 * annotations included. Elsewhere it is the plain fold render as of that
 * event; an event whose render is identical to the previous event's gains the
 * "ⓘ no change to the rendered request" note lines.
 */
export function computeChainSnapshots(
  scenario: LoadedScenario,
  byId: Map<string, LoadedScenario>,
): { off: number; content: string }[] {
  const requests = chainRequests(scenario, byId);
  if (requests.length === 0) {
    throw new Error(
      `${scenario.fileName}: a scenario needs at least one llm-request-requested event`,
    );
  }
  const pinnedByOffset = new Map<number, string>();
  for (const request of requests) {
    const outputs = computeScenarioOutputs(request.owner);
    const output = outputs.find((candidate) => candidate.offset === request.offset)!;
    pinnedByOffset.set(request.offset, output.content.trimEnd());
  }
  let previousPlain: string | null = null;
  return scenario.chainEntries.map((entry) => {
    const maxOff = synthesizeEvents(entry).at(-1)!.offset;
    const pinned = pinnedByOffset.get(entry.off);
    // The model line mirrors what a request fired here would carry: the
    // nearest requested event at-or-after this offset, else the latest one.
    const model = (requests.find((request) => request.offset >= maxOff) || requests.at(-1)!).model;
    const rendered =
      pinned === undefined ? renderChainSnapshotLines(scenario, maxOff, model).join("\n") : pinned;
    const plain = stripCommentLines(rendered);
    const content =
      previousPlain !== null && plain === previousPlain
        ? noChangeNote(entry, scenario) + rendered
        : rendered;
    previousPlain = plain;
    return { off: entry.off, content };
  });
}

function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("# "))
    .join("\n");
}

function noChangeNote(entry: ScenarioEntry, scenario: LoadedScenario): string {
  const index = scenario.chainEntries.indexOf(entry);
  const previousOff = scenario.chainEntries[index - 1]!.off;
  if (entry.type === "agent/configured" || entry.type === "agent/created") {
    return (
      `# ⓘ no change to the rendered request — @${entry.off} configures the agent\n` +
      `#   (debounce / parsing flag), it adds nothing the model sees. Identical to @${previousOff}.\n`
    );
  }
  return (
    `# ⓘ no change to the rendered request — @${entry.off} is turn-loop machinery\n` +
    `#   (never model-visible), it adds nothing the model sees. Identical to @${previousOff}.\n`
  );
}

type EventCard = {
  off: number;
  t: string;
  type: string;
  shared: boolean;
  badges: string[];
  preview: string | null;
  note: string | null;
  yaml: string;
  sched: string;
  paneTitle: string;
  /** The request-so-far as of this event. The comment-free render is
   * suffix-encoded against the previous card's (`p` chars shared, then `s` —
   * the fold's superset property keeps most suffixes small); `c` carries the
   * woven `#` comment lines as [displayIndex, text] inserts, so the
   * client-side reconstruction is byte-identical to the server render. */
  snap: { p: number; s: string; c?: [number, string][] };
};

function renderScenarioData(scenario: LoadedScenario, byId: Map<string, LoadedScenario>) {
  const shortTitle = scenario.title.split(" — ")[0]!;
  const baseCount = scenario.chainEntries.length - scenario.entries.length;
  const base = scenario.base === null ? null : byId.get(scenario.base)!;
  const requests = chainRequests(scenario, byId);
  const snapshots = computeChainSnapshots(scenario, byId);
  let previousPlain = "";
  const events: EventCard[] = scenario.chainEntries.map((entry, index) => {
    const maxOff = synthesizeEvents(entry).at(-1)!.offset;
    const state = reduceAgentEvents(scenario.chainEvents.filter((event) => event.offset <= maxOff));
    const comments: [number, string][] = [];
    const plainLines: string[] = [];
    snapshots[index]!.content.split("\n").forEach((line, lineIndex) => {
      if (line.trim().startsWith("# ")) comments.push([lineIndex, line]);
      else plainLines.push(line);
    });
    const plain = plainLines.join("\n");
    let shared = 0;
    while (
      shared < plain.length &&
      shared < previousPlain.length &&
      plain[shared] === previousPlain[shared]
    ) {
      shared++;
    }
    const snap = {
      p: shared,
      s: plain.slice(shared),
      ...(comments.length > 0 && { c: comments }),
    };
    previousPlain = plain;
    return {
      off: entry.off,
      t: entry.t,
      type: entry.type,
      shared: index < baseCount,
      badges: cardBadges(entry),
      preview: cardPreview(entry),
      note: entry.note || null,
      yaml: cardYaml(entry),
      sched: schedLine({ state, requests }),
      paneTitle:
        `Provider request as of <span class="off">@${entry.off}</span> ` +
        `<span style="font-weight:400;color:var(--muted)">(${shortTitle} · t=${entry.t})</span>`,
      snap,
    };
  });
  return {
    id: scenario.id,
    title: scenario.title,
    intro: scenario.intro.replace(/\s*\n\s*/g, " "),
    sharedSummary:
      base === null
        ? null
        : `…the ${base.chainEntries.length} events of ${base.title.split(" — ")[0]!.toLowerCase()}, replayed in full (shared start — click to expand)`,
    events,
  };
}

function schedLine(input: {
  state: ReturnType<typeof reduceAgentEvents>;
  requests: { offset: number; tMs: number }[];
}): string {
  const { state, requests } = input;
  const debounceMs = state.config.llmRequestDebounceMs;
  const pending = state.pendingLlmRequestTrigger;
  if (pending !== null) {
    const triggerElapsedMs = pending.atMs - SCENARIO_TIME_ZERO;
    return (
      `⏱ <b>due to be sent at ${formatElapsed(triggerElapsedMs + debounceMs)}</b> — ` +
      `trigger @${pending.offset} (${formatElapsed(triggerElapsedMs)}) + ${formatElapsed(debounceMs)} debounce`
    );
  }
  if (state.lastLlmRequestOffset > 0) {
    const sent = requests.find((request) => request.offset === state.lastLlmRequestOffset);
    const sentAt = sent === undefined ? "" : ` at ${formatElapsed(sent.tMs)}`;
    return `✓ <b>sent${sentAt}</b> — request @${state.lastLlmRequestOffset} covered the trigger`;
  }
  return `nothing pending — no uncovered trigger · debounce ${formatElapsed(debounceMs)}`;
}

function cardBadges(entry: ScenarioEntry): string[] {
  const payload = entry.payload || {};
  switch (entry.type) {
    case "agents/context-rewritten":
      return [`⚠ ${payload.op} ${payload.key === "*" ? "*" : `[key=${payload.key}]`}`];
    case "agents/context-added": {
      if (payload.sections !== undefined) {
        const keys = (payload.sections as { key: string }[]).map((section) => section.key);
        return [`×${keys.length} events, one batch`, `key=${keys[0]}`, `+${keys.length - 1} more`];
      }
      if (payload.key !== undefined) return [`key=${payload.key}`];
      return [payload.role];
    }
    case "agent/configured": {
      const badges: string[] = [];
      const config = payload.config || {};
      if (typeof config.llmRequestDebounceMs === "number") {
        badges.push(`debounce=${formatElapsed(config.llmRequestDebounceMs)}`);
      }
      if (typeof config.interpretResponses === "boolean") {
        badges.push(`parsing=${config.interpretResponses ? "on" : "off"}`);
      }
      return badges;
    }
    case "agent/llm-request-settled":
      return [`request @${payload.requestOffset}`, `status=${payload.result?.status}`];
    case "capability-host/script-run-requested":
      return [`executionId=${payload.executionId}`];
    case "capability-host/script-run-settled":
      return [`executionId=${payload.executionId}`, `status=${payload.settlement?.status}`];
    default:
      return [];
  }
}

function cardPreview(entry: ScenarioEntry): string | null {
  const payload = entry.payload || {};
  const isTurn =
    entry.type === "agents/context-added" &&
    payload.key === undefined &&
    payload.sections === undefined &&
    typeof payload.content === "string";
  if (!isTurn) return null;
  const firstLine: string = payload.content.split("\n")[0];
  const truncated = payload.content.length > 110 || payload.content.includes("\n");
  return firstLine.slice(0, 110) + (truncated ? "…" : "");
}

function cardYaml(entry: ScenarioEntry): string {
  const events = synthesizeEvents(entry);
  const renderOne = (event: (typeof events)[number], listItem: boolean) => {
    const outer = listItem ? "  " : "";
    const lines = [
      `${listItem ? "- " : ""}offset: ${event.offset}`,
      `${outer}type: ${event.type}`,
      `${outer}createdAt: ${event.createdAt}`,
      `${outer}payload:`,
      ...yamlifyValue(event.payload, outer + "  "),
    ];
    return lines.join("\n");
  };
  if (events.length === 1) return renderOne(events[0]!, false);
  return events.map((event) => renderOne(event, true)).join("\n");
}
