// Generates explainers/prompt-sections.html from the scenario fixtures: a
// static shell (explainer-shell.html — header, opinion box, vocabulary
// tables, appendices, and the thin renderer script) plus one embedded JSON
// payload derived here. Everything interactive on the page is a lookup over
// this payload: the pinned request bodies come from the same computation the
// fixture output fences assert, and the per-event scheduling notes come from
// the real fold's reduced state (pending trigger + debounce config).
// prompt-scenarios.test.ts owns freshness: `-u` writes the page, plain runs
// assert the committed page matches.
import fs from "node:fs";
import path from "node:path";
import { reduceAgentEvents } from "../agent-prompt-fold.ts";
import {
  computeScenarioOutputs,
  formatElapsed,
  parseElapsed,
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
  const requests: Record<string, string> = {};
  for (const scenario of scenarios) {
    for (const output of computeScenarioOutputs(scenario)) {
      requests[`${scenario.id}@${output.offset}`] = output.content.trimEnd();
    }
  }
  const data = {
    scenarios: scenarios.map((scenario) => renderScenarioData(scenario, byId)),
    requests,
  };
  const shell = fs.readFileSync(shellPath, "utf8");
  if (!shell.includes(DATA_PLACEHOLDER)) {
    throw new Error(`explainer-shell.html is missing the ${DATA_PLACEHOLDER} placeholder`);
  }
  // "</" escaped as the JSON-legal "<\/" so no content string can terminate
  // the embedding <script> element early.
  const json = JSON.stringify(data, null, 2).replaceAll("</", "<\\/");
  return shell.replace(DATA_PLACEHOLDER, json);
}

/** Every llm-request-requested event in a scenario's chain, tagged with the
 * scenario that OWNS its pinned render (the one whose fixture holds the
 * output fence). */
function chainRequests(
  scenario: LoadedScenario,
  byId: Map<string, LoadedScenario>,
): { offset: number; tMs: number; key: string }[] {
  const own = scenario.entries
    .filter((entry) => entry.type === "agent/llm-request-requested")
    .map((entry) => ({
      offset: entry.off,
      tMs: parseElapsed(entry.t),
      key: `${scenario.id}@${entry.off}`,
    }));
  if (scenario.base === null) return own;
  return [...chainRequests(byId.get(scenario.base)!, byId), ...own];
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
  showRequest: string | null;
};

function renderScenarioData(scenario: LoadedScenario, byId: Map<string, LoadedScenario>) {
  const shortTitle = scenario.title.split(" — ")[0]!;
  const baseCount = scenario.chainEntries.length - scenario.entries.length;
  const base = scenario.base === null ? null : byId.get(scenario.base)!;
  const requests = chainRequests(scenario, byId);
  const events: EventCard[] = scenario.chainEntries.map((entry, index) => {
    const expanded = synthesizeEvents(entry);
    const maxOff = expanded.at(-1)!.offset;
    const covering = requests.find((request) => request.offset >= maxOff);
    const prior = requests.filter((request) => request.offset <= maxOff).at(-1);
    const showRequest = covering || prior || null;
    const state = reduceAgentEvents(scenario.chainEvents.filter((event) => event.offset <= maxOff));
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
      paneTitle: paneTitle({ entry, shortTitle, covering, prior }),
      showRequest: showRequest === null ? null : showRequest.key,
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

function paneTitle(input: {
  entry: ScenarioEntry;
  shortTitle: string;
  covering: { offset: number; key: string } | undefined;
  prior: { offset: number; key: string } | undefined;
}): string {
  const { entry, shortTitle, covering, prior } = input;
  const meta = (text: string) =>
    ` <span style="font-weight:400;color:var(--muted)">(${text})</span>`;
  const off = (value: number) => `<span class="off">@${value}</span>`;
  if (covering !== undefined && covering.offset === entry.off) {
    return `Provider request ${off(entry.off)}${meta(`${shortTitle} · t=${entry.t}`)}`;
  }
  if (covering !== undefined) {
    return `Provider request ${off(covering.offset)}${meta(`covers @${entry.off} · ${shortTitle} · t=${entry.t}`)}`;
  }
  if (prior !== undefined) {
    return `Provider request ${off(prior.offset)}${meta(`latest sent — @${entry.off} not yet covered · ${shortTitle} · t=${entry.t}`)}`;
  }
  return `No request yet${meta(`${shortTitle} · t=${entry.t}`)}`;
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
