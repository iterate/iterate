// Markdown data fixtures for the agent prompt fold, inspired by the sqlfu
// repo's generate fixtures (https://github.com/mmkal/sqlfu,
// packages/sqlfu/test/generate/fixture-helpers.ts): the same
// details/summary + ```lang (path) fence format and the same
// rewrite-outputs-in-place update mode driven by a vitest `updateSnapshots`
// provide flag. Modifications for this suite: fixtures hold agent stream
// events (YAML) instead of SQL/TS input files; outputs are provider request
// bodies computed by the REAL fold (buildAgentLlmRequestBody) rather than a
// generator writing to disk; and an annotations fence injects `#` comment
// lines into rendered outputs so commentary survives regeneration.
//
// One fixture .md per scenario:
//   - intro prose (first heading is the scenario title)
//   - a <details><summary>events</summary> block with one
//     ```yaml (events.yaml) fence — `id`, optional `base: <scenario id>`
//     (prepends that scenario's events), and the ordered `events` list
//     (`off`/`t`/`type`/`payload`/`note` per entry; an entry whose payload
//     carries `sections` expands into one keyed context-added event per
//     section, offsets off..off+N-1 — the atomic prompt-file batch) — plus an
//     optional ```yaml (annotations.yaml) fence
//   - one <details><summary>request @N</summary> block per
//     llm-request-requested event, holding the rendered request at that
//     offset. These are the regenerated outputs: never hand-edit them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { cachedEventSchema, getConsumedEventDefinition } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import { AgentProcessorContract } from "../agent-processor-contract.ts";
import { buildAgentLlmRequestBody, reduceAgentEvents } from "../agent-prompt-fold.ts";

declare module "vitest" {
  interface ProvidedContext {
    updateSnapshots: boolean;
  }
}

export const scenarioDir = path.dirname(fileURLToPath(import.meta.url));

/** Every wall-clock value in a fixture is an elapsed-time label relative to
 * this instant — the agent's creation. Stamps and expiry horizons derive from
 * it, so rendered "Requested at:" lines are deterministic. */
export const SCENARIO_TIME_ZERO = Date.parse("2026-08-24T16:41:00.000Z");

const EVENT_TYPE_PREFIX = "events.iterate.com/";
/** Scheduling expiry horizon derived for requested events whose fixture
 * payload omits `expiresAt` — expiry is turn-loop machinery, irrelevant to
 * what any scenario teaches, so fixtures may leave it out for readability.
 * An explicit `expiresAt` in a fixture payload always wins. */
const DERIVED_EXPIRY_MS = 30_000;

export type ScenarioEntry = {
  off: number;
  t: string;
  type: string;
  payload: any;
  note?: string;
};

export type ScenarioAnnotation = { request: string; find: string; comment: string };

export type ParsedScenario = {
  filePath: string;
  fileName: string;
  id: string;
  base: string | null;
  title: string;
  intro: string;
  entries: ScenarioEntry[];
  annotations: ScenarioAnnotation[];
};

export type LoadedScenario = ParsedScenario & {
  /** Base chain entries + own entries, in replay order. */
  chainEntries: ScenarioEntry[];
  /** Synthesized stream events for the full chain, contract-validated. */
  chainEvents: StreamEvent[];
  /** Offsets of this scenario's OWN llm-request-requested events — the
   * fixture's output fences, one per offset. */
  requestOffsets: number[];
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

export function listScenarioFiles(): string[] {
  return fs
    .readdirSync(scenarioDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(scenarioDir, name));
}

const FENCE_PATTERN =
  /^```(?<lang>[\w-]+)[ \t]+\((?<path>[^)]+)\)[ \t]*\n(?<content>[\s\S]*?)^```[ \t]*$/gm;

export function parseScenarioFile(filePath: string): ParsedScenario {
  const text = fs.readFileSync(filePath, "utf8");
  const fileName = path.basename(filePath);
  const titleMatch = text.match(/^# (.+)$/m);
  if (!titleMatch) throw new Error(`${fileName}: no "# <title>" heading`);
  const detailsIndex = text.indexOf("<details>");
  if (detailsIndex < 0) throw new Error(`${fileName}: no <details> block`);
  const intro = text.slice(titleMatch.index! + titleMatch[0].length, detailsIndex).trim();

  const fences: Record<string, string> = {};
  for (const match of text.matchAll(FENCE_PATTERN)) {
    fences[match.groups!.path!.trim()] = match.groups!.content!;
  }
  const eventsYaml = fences["events.yaml"];
  if (eventsYaml === undefined) throw new Error(`${fileName}: no \`\`\`yaml (events.yaml) fence`);
  const parsed = YAML.parse(eventsYaml) as {
    id?: string;
    base?: string;
    events?: ScenarioEntry[];
  };
  if (!parsed?.id) throw new Error(`${fileName}: events.yaml needs a top-level \`id\``);
  if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
    throw new Error(`${fileName}: events.yaml needs a non-empty \`events\` list`);
  }
  const annotations =
    fences["annotations.yaml"] === undefined
      ? []
      : (YAML.parse(fences["annotations.yaml"]) as ScenarioAnnotation[]);
  return {
    filePath,
    fileName,
    id: parsed.id,
    base: parsed.base || null,
    title: titleMatch[1]!,
    intro,
    entries: parsed.events,
    annotations,
  };
}

// -----------------------------------------------------------------------------
// Elapsed-time labels (ported from the explainer's original hand-written
// helpers so existing labels like "10m 16s" and "3m–19m" keep their meaning).
// -----------------------------------------------------------------------------

export function parseElapsed(label: string): number {
  const part = label.split("–").pop()!.trim();
  if (/^[\d.]+ms$/.test(part)) return parseFloat(part);
  const match = part.match(/^(?:(\d+)m)?\s*(?:([\d.]+)s)?$/);
  if (!match) throw new Error(`unparseable elapsed-time label: ${JSON.stringify(label)}`);
  return (
    (match[1] ? parseInt(match[1], 10) * 60_000 : 0) + (match[2] ? parseFloat(match[2]) * 1000 : 0)
  );
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 120_000) return `${Math.round(ms / 100) / 10}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

// -----------------------------------------------------------------------------
// Event synthesis: fixture entries -> contract-valid StreamEvents
// -----------------------------------------------------------------------------

function isoAt(elapsedMs: number): string {
  return new Date(SCENARIO_TIME_ZERO + elapsedMs).toISOString();
}

/** One fixture entry can synthesize several events: a payload carrying
 * `sections` is the parsed prompt file — one keyed context-added per section,
 * offsets off..off+N-1, riding one atomic batch. */
export function synthesizeEvents(entry: ScenarioEntry): StreamEvent[] {
  const elapsedMs = parseElapsed(entry.t);
  const type = EVENT_TYPE_PREFIX + entry.type;
  const streamEvent = (offset: number, payload: any): StreamEvent => ({
    type,
    payload,
    offset,
    createdAt: isoAt(elapsedMs),
    path: "/agents/web/demo",
  });
  if (entry.payload?.sections !== undefined) {
    const { sections, ...rest } = entry.payload;
    return (sections as { key: string; content: string }[]).map((section, index) =>
      streamEvent(entry.off + index, { ...rest, key: section.key, content: section.content }),
    );
  }
  const needsExpiry =
    (entry.type === "agent/llm-request-requested" ||
      entry.type === "capability-host/script-run-requested") &&
    entry.payload?.expiresAt === undefined;
  const payload = needsExpiry
    ? { ...entry.payload, expiresAt: SCENARIO_TIME_ZERO + elapsedMs + DERIVED_EXPIRY_MS }
    : entry.payload;
  return [streamEvent(entry.off, payload)];
}

/** Streams accept raw appends and the fold silently skips malformed events —
 * exactly the wrong behavior for a teaching fixture, where a typo'd payload
 * would silently vanish from the rendered request. So every synthesized event
 * must parse against its consumed-event definition, loudly. */
export function validateEvents(events: StreamEvent[], context: string): void {
  for (const event of events) {
    const definition = getConsumedEventDefinition({
      contract: AgentProcessorContract,
      eventType: event.type,
    });
    if (definition === undefined) {
      throw new Error(
        `${context}: @${event.offset} has type ${event.type}, which the agent processor does not consume`,
      );
    }
    const parsed = cachedEventSchema({
      type: event.type,
      payloadSchema: definition.payloadSchema,
    }).safeParse(event);
    if (!parsed.success) {
      throw new Error(
        `${context}: @${event.offset} (${event.type}) payload fails the contract schema:\n` +
          JSON.stringify(parsed.error.issues, null, 2) +
          `\npayload: ${JSON.stringify(event.payload, null, 2)}`,
      );
    }
  }
}

export function loadScenarios(): LoadedScenario[] {
  const parsed = listScenarioFiles().map(parseScenarioFile);
  const byId = new Map(parsed.map((scenario) => [scenario.id, scenario]));
  const chainEntriesOf = (scenario: ParsedScenario): ScenarioEntry[] => {
    if (scenario.base === null) return scenario.entries;
    const base = byId.get(scenario.base);
    if (!base)
      throw new Error(
        `${scenario.fileName}: unknown base scenario ${JSON.stringify(scenario.base)}`,
      );
    return [...chainEntriesOf(base), ...scenario.entries];
  };
  return parsed.map((scenario) => {
    const chainEntries = chainEntriesOf(scenario);
    const chainEvents = chainEntries.flatMap(synthesizeEvents);
    validateEvents(chainEvents, scenario.fileName);
    const offsets = chainEvents.map((event) => event.offset);
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i]! <= offsets[i - 1]!) {
        throw new Error(
          `${scenario.fileName}: event offsets must strictly increase (@${offsets[i]} after @${offsets[i - 1]})`,
        );
      }
    }
    return {
      ...scenario,
      chainEntries,
      chainEvents,
      requestOffsets: scenario.entries
        .filter((entry) => entry.type === "agent/llm-request-requested")
        .map((entry) => entry.off),
    };
  });
}

// -----------------------------------------------------------------------------
// Rendering: fold output -> deterministic YAML lines
// -----------------------------------------------------------------------------

export function requestedOffsetsInChain(scenario: LoadedScenario): number[] {
  return scenario.chainEvents
    .filter((event) => event.type === EVENT_TYPE_PREFIX + "agent/llm-request-requested")
    .map((event) => event.offset);
}

/** The rendered provider request at one requested offset, as plain YAML lines
 * (comments not yet woven in). The model line comes from the requested
 * event's own payload — it is part of the request the fold's messages ride
 * in. */
export function renderRequestPlainLines(scenario: LoadedScenario, requestOffset: number): string[] {
  const events = scenario.chainEvents;
  const requested = events.find(
    (event) =>
      event.offset === requestOffset &&
      event.type === EVENT_TYPE_PREFIX + "agent/llm-request-requested",
  );
  if (!requested) {
    throw new Error(`${scenario.fileName}: no llm-request-requested event at @${requestOffset}`);
  }
  // Guard against a requested event the reduce ignored (no pending trigger,
  // another request still open, or paused): the fixture would otherwise pin a
  // request that never happened.
  const state = reduceAgentEvents(events.filter((event) => event.offset <= requestOffset));
  if (state.lastLlmRequestOffset !== requestOffset) {
    throw new Error(
      `${scenario.fileName}: the requested event @${requestOffset} reduced to nothing — ` +
        `no pending trigger, an unsettled open request, or a pause swallowed it. ` +
        `Check the scenario has a triggering item before it and an llm-request-settled ` +
        `event for every earlier request.`,
    );
  }
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: requestOffset });
  const lines: string[] = [`model: ${(requested.payload as any).model}`, "messages:"];
  for (const message of messages) {
    lines.push(`  - role: ${message.role}`);
    if (message.content.includes("\n")) {
      lines.push("    content: |-");
      for (const line of message.content.split("\n")) {
        lines.push(line === "" ? "" : `      ${line}`);
      }
    } else {
      lines.push(`    content: ${JSON.stringify(message.content)}`);
    }
    if (message.files !== undefined && message.files.length > 0) {
      lines.push("    files:");
      for (const file of message.files) {
        lines.push(`      - ${JSON.stringify(file)}`);
      }
    }
  }
  return lines;
}

const CACHE_CUT_COMMENT =
  "# ✂ provider cache: every token above this line is a byte-stable prefix (cached)";

/**
 * Weave derived comments into a rendered request:
 *   - the ✂ cache-cut line at the first line where this request diverges from
 *     the previous request in the chain (the fold's superset property puts it
 *     right after the previous request's last line; a context-rewritten op
 *     drags it up — that visible jump IS the cache-bust lesson)
 *   - one `# <comment>` line per annotation, above the first plain line
 *     containing its `find` substring. An annotation matching nothing fails:
 *     a stale annotation is a broken explainer.
 */
export function weaveComments(input: {
  plainLines: string[];
  previousPlainLines: string[] | null;
  annotations: ScenarioAnnotation[];
  context: string;
}): string {
  const { plainLines, previousPlainLines, annotations, context } = input;
  const inserts: { index: number; text: string }[] = [];
  const indentOf = (index: number) => {
    const line = plainLines[Math.min(index, plainLines.length - 1)] || "";
    return line.match(/^\s*/)![0];
  };
  if (previousPlainLines !== null) {
    let cut = 0;
    while (
      cut < plainLines.length &&
      cut < previousPlainLines.length &&
      plainLines[cut] === previousPlainLines[cut]
    ) {
      cut++;
    }
    inserts.push({ index: cut, text: indentOf(cut) + CACHE_CUT_COMMENT });
  }
  for (const annotation of annotations) {
    const index = plainLines.findIndex((line) => line.includes(annotation.find));
    if (index < 0) {
      throw new Error(
        `${context}: annotation find=${JSON.stringify(annotation.find)} matches no rendered line — ` +
          `stale annotation, update or remove it (comment: ${JSON.stringify(annotation.comment)})`,
      );
    }
    inserts.push({ index, text: `${indentOf(index)}# ${annotation.comment}` });
  }
  inserts.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  let insertCursor = 0;
  for (let i = 0; i <= plainLines.length; i++) {
    while (insertCursor < inserts.length && inserts[insertCursor]!.index === i) {
      out.push(inserts[insertCursor]!.text);
      insertCursor++;
    }
    if (i < plainLines.length) out.push(plainLines[i]!);
  }
  return out.join("\n") + "\n";
}

/** The finished output fence content for every request the scenario pins:
 * rendered by the real fold, ✂-marked against the previous request in the
 * chain, annotated per the fixture's annotations.yaml. */
export function computeScenarioOutputs(
  scenario: LoadedScenario,
): { offset: number; content: string }[] {
  const chainRequestOffsets = requestedOffsetsInChain(scenario);
  const knownRequests = new Set(scenario.requestOffsets.map((offset) => `@${offset}`));
  for (const annotation of scenario.annotations) {
    if (!knownRequests.has(annotation.request)) {
      throw new Error(
        `${scenario.fileName}: annotation targets ${annotation.request}, but this scenario's own ` +
          `requests are ${[...knownRequests].join(", ") || "(none)"}`,
      );
    }
  }
  return scenario.requestOffsets.map((offset) => {
    const previousOffset = chainRequestOffsets.filter((candidate) => candidate < offset).at(-1);
    return {
      offset,
      content: weaveComments({
        plainLines: renderRequestPlainLines(scenario, offset),
        previousPlainLines:
          previousOffset === undefined ? null : renderRequestPlainLines(scenario, previousOffset),
        annotations: scenario.annotations.filter(
          (annotation) => annotation.request === `@${offset}`,
        ),
        context: `${scenario.fileName} request@${offset}`,
      }),
    };
  });
}

// -----------------------------------------------------------------------------
// Fixture regeneration: everything through the events </details> is
// hand-authored and preserved; the request blocks after it are regenerated
// wholesale, one <details> per pinned request, in event order.
// -----------------------------------------------------------------------------

export function regenerateFixtureText(
  original: string,
  outputs: { offset: number; content: string }[],
): string {
  const headEnd = original.indexOf("</details>");
  if (headEnd < 0) throw new Error("fixture has no events </details> block");
  const head = original.slice(0, headEnd + "</details>".length);
  const blocks = outputs.map(
    ({ offset, content }) =>
      `<details>\n<summary>request @${offset}</summary>\n\n` +
      `\`\`\`yaml (request@${offset}.yaml)\n${content}\`\`\`\n\n</details>`,
  );
  return [head, ...blocks].join("\n\n") + "\n";
}

/** Generic deterministic YAML printer for event payloads shown on the
 * explainer's event cards (insertion-order keys, JSON-quoted strings, block
 * scalars for multiline strings). Display-only — never parsed back. */
export function yamlifyValue(value: any, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const itemLines = yamlifyValue(item, indent + "  ");
      if (isScalar(item)) return [`${indent}- ${scalarYaml(item)}`];
      // Object/array item: fold the first rendered line onto the dash.
      const [first, ...rest] = itemLines;
      return [`${indent}- ${first!.slice(indent.length + 2)}`, ...rest];
    });
  }
  if (isScalar(value)) return [`${indent}${scalarYaml(value)}`];
  return Object.entries(value as Record<string, any>).flatMap(([key, entryValue]) => {
    if (typeof entryValue === "string" && entryValue.includes("\n")) {
      return [
        `${indent}${key}: |-`,
        ...entryValue.split("\n").map((line) => (line === "" ? "" : `${indent}  ${line}`)),
      ];
    }
    if (isScalar(entryValue)) return [`${indent}${key}: ${scalarYaml(entryValue)}`];
    if (Array.isArray(entryValue) && entryValue.length === 0) return [`${indent}${key}: []`];
    return [`${indent}${key}:`, ...yamlifyValue(entryValue, indent + "  ")];
  });
}

function isScalar(value: any): boolean {
  return value === null || typeof value !== "object";
}

function scalarYaml(value: any): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
