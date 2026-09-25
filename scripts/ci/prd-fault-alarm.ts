// Prd fault alarm (prd-fault-alarm.yml, every 15 minutes): reads the first-party prd Workers' Logs
// since its last run and pages #error-pulse on any 5xx, a burst of platform-failure heals, or any error.
// On 2026-09-23 a Cloudflare fault let each first-party facet start answer ONE call for ~2.5 hours:
// ~1,800 heals and ~2,400 errors per half hour, 41 homepage 500s on lispwoso.com and garple.com —
// and our recovery kept most requests green, so only the logs knew.
//
// Each fault is an incident: a 5xx host, a healed facet's name, or an error message. A new one pages
// at the top level, mentioning Jonas; its repeats go quietly into that page's thread, back in the
// channel (and mentioning Jonas) once it grows tenfold; a day unseen closes it. Until 2026-09-24 the
// alarm held every page for an hour after any page while reading only the last half hour, so a
// different 500 in that hour was never posted. The memory is the run's `prd-fault-alarm-state`
// artifact: where the next read starts and the open incidents' threads. Without it a run reads the
// last half hour and pages everything as new — a repeat, never a miss.
//
// A workaround that heals a platform fault logs `console.warn({ event:
// "<area>.platform-failure-<action>", name, … })` (apps/os context/facet-host.ts); naming it so
// is all it takes to be alarmed. One whose defect is too rare to pin with a failing test is pinned
// here instead (PINNED_WORKAROUNDS): the alarm posts once when its heal has been absent for weeks.
//
//   doppler run --project os --config prd -- pnpm tsx scripts/ci/prd-fault-alarm.ts run
//   … run --ref <git ref> --state <previous.json> --state-out <next.json>   # keeps state on main only
//   … run --at 2026-09-23T07:30:00Z --dry-run    # replay the half hour to then, post nothing
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import {
  PLATFORM_FAILURE_DELAYS_MS,
  retryPlatformFailures,
} from "@iterate-com/shared/platform-retry";
import {
  agentsEnvs,
  dashEnvs,
  kitEnvs,
  notesEnvs,
  osEnvs,
  PRD_ACCOUNT_ID,
  spaEnvs,
  voiceEnvs,
} from "../../envs.ts";
import { saveNewestArtifactFile } from "./depot.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";

/** Every first-party Worker in production: the platform and its clients. A 5xx or an error in any
 *  of them pages; before 2026-09-24 only os-prd's did, and voice.iterate.com answered robots.txt
 *  with a 500 unseen. */
const PRD_WORKERS = [
  osEnvs.prd!,
  dashEnvs.prd,
  agentsEnvs.prd,
  notesEnvs.prd,
  voiceEnvs.prd,
  kitEnvs.prd,
  spaEnvs.prd,
].map((env) => env.workerName);

/** Where one run leaves its state for the next: the workflow's `name:`, the artifact and its file. */
export const stateArtifact = {
  workflow: "Prd fault alarm (Depot CI)",
  artifact: "prd-fault-alarm-state",
  file: "state.json",
};

/** The prd account's Workers Logs API access. */
type CloudflareCredentials = { accountId: string; apiToken: string };

/** One window's rows per signal: [label, count], biggest first. `pagers` is not a fault: the
 *  rpc-stub pagers' re-dial outcomes by event, the recovery a page shows beside a connection's
 *  close (apps/os context/rpc-stubs.ts); one that gives up logs an error, which is. `healEvents` is
 *  `heals` by event instead of by name, for PINNED_WORKAROUNDS. */
export type FaultReading = Record<
  "serverErrors" | "heals" | "healEvents" | "errors" | "pagers",
  [string, number][]
>;

/**
 * WORKAROUNDS PINNED BY PRD TELEMETRY. A workaround for a platform defect stays only while a test
 * fails once the defect is fixed (docs/engineering-invariants.md). A defect too rare to reproduce in
 * a test is pinned here instead, by the heal its workaround logs: each run notes when prd last
 * logged it, and once prd has logged none for `PIN_QUIET_DAYS`, the run posts once to #error-pulse
 * that the workaround can go. A heal seen again starts the count over. The count lives in the
 * state, because Workers Logs cannot answer for 28 days: on 2026-09-24 a query spanning six days or
 * more answered empty, with success, where one of five found the heals, and empty would read as
 * fixed. A run without state starts the count again: a late post, never a false one.
 */
export const PINNED_WORKAROUNDS = [
  {
    /** What every `event` of the workaround's heals starts with. */
    event: "iterate-context.platform-failure-alarm-",
    /** The post, once the heal has been absent `PIN_QUIET_DAYS`. */
    post: "Cloudflare seems to have fixed held Durable Object alarms: delete the overdue watch in apps/os/src/alarm-coordinator.ts",
  },
];
export const PIN_QUIET_DAYS = 28;

/** The logs one run reads: from where the last run stopped to now. */
export type LogWindow = { from: Date; to: Date };

/** What the alarm remembers between runs. `readUntil` is where the next read starts; each open
 *  incident, by its key, holds the thread of the page that opened it, how often it was seen and the
 *  count the channel last heard. Each pinned workaround, by its event, holds when prd last logged
 *  its heal (or when the count started) and whether its post went out. */
export const AlarmState = z.object({
  readUntil: z.string(),
  incidents: z.record(
    z.string(),
    z.object({ thread: z.string(), lastSeen: z.string(), count: z.number(), told: z.number() }),
  ),
  pins: z.record(z.string(), z.object({ lastSeen: z.string(), told: z.boolean() })),
});
export type AlarmState = z.infer<typeof AlarmState>;

/** Reads the prd Workers' Logs since the last run and pages #error-pulse on a fault. */
export async function run(
  options: { at?: string; dryRun?: boolean; ref?: string; state?: string; stateOut?: string } = {},
) {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
  if (!accountId || !apiToken) throw new Error("run under doppler --project os --config prd");
  // A replay reads its own half hour and neither reads nor keeps the state.
  const state =
    !options.at && options.state && existsSync(options.state)
      ? AlarmState.parse(JSON.parse(readFileSync(options.state, "utf8")))
      : null;
  const outcome = await alarm({
    window: options.at
      ? { from: new Date(Date.parse(options.at) - 30 * 60_000), to: new Date(options.at) }
      : logWindow(new Date(), state),
    state,
    cloudflare: { accountId, apiToken },
    // A dry run posts nothing, so it needs no Slack token.
    slack: options.dryRun ? null : getSlackClient,
  });
  // After every post: a run that failed to post keeps no state, so the next one reads its window
  // again and posts what this one owed. Only a run on main (`ref`, the run's git ref) keeps it: a
  // dispatch on a branch must not move main's read window or its open incidents.
  if (options.stateOut && options.ref === "refs/heads/main" && !options.at && !options.dryRun) {
    mkdirSync(dirname(options.stateOut), { recursive: true });
    writeFileSync(options.stateOut, `${JSON.stringify(outcome.next, null, 2)}\n`);
  }
  return outcome.summary;
}

/**
 * Reads `window` (logWindow) and posts each new incident's page and each open one's thread reply. `slack: null` posts nothing.
 * It resolves to what it posted (or would post) and the next state, so a paged run ends green: a
 * scheduled run reports on main's head commit, where red reads as "this commit broke". It throws
 * only when it could not read prd (readWindow) or post (the Slack client throws on an error).
 */
export async function alarm(input: {
  window: LogWindow;
  state: AlarmState | null;
  cloudflare: CloudflareCredentials;
  slack: (() => WebClient) | null;
  /** The waits before each repeat of a Workers Logs query Cloudflare failed (readWindow). */
  delaysMs?: readonly number[];
}) {
  const { window, delaysMs = PLATFORM_FAILURE_DELAYS_MS } = input;
  const reading = await readWindow(window, input.cloudflare, delaysMs);
  console.log(JSON.stringify({ window, reading }));
  const triage = triageIncidents(reading, window, input.state);
  const pinned = pinnedWorkarounds(reading.healEvents, window, input.state);
  // Only a run that owes a post needs Slack: a quiet run stays green whatever its token does.
  const slack =
    triage.page || triage.replies.length || pinned.posts.length ? input.slack?.() : undefined;
  const channel = slackChannelIds["#error-pulse"];
  const incidents = { ...triage.incidents };
  if (triage.page && slack) {
    const posted = await slack.chat.postMessage({ channel, text: triage.page.text });
    // The client throws on an error, and every posted message has its ts.
    for (const key of triage.page.keys) incidents[key] = { ...incidents[key]!, thread: posted.ts! };
  }
  for (const reply of triage.replies)
    await slack?.chat.postMessage({
      channel,
      thread_ts: reply.thread,
      text: reply.text,
      reply_broadcast: reply.broadcast,
    });
  for (const text of pinned.posts) await slack?.chat.postMessage({ channel, text });
  const summary = [triage.page?.text, ...triage.replies.map((reply) => reply.text), ...pinned.posts]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: summary || "prd is quiet",
    next: {
      readUntil: window.to.toISOString(),
      incidents,
      pins: pinned.pins,
    } satisfies AlarmState,
  };
}

/** What PINNED_WORKAROUNDS owe after `window`: each pin's next state, and the posts of those whose
 *  heal has now been absent `PIN_QUIET_DAYS` and not yet posted. Pure. */
export function pinnedWorkarounds(
  healEvents: [string, number][],
  window: LogWindow,
  state: AlarmState | null,
) {
  const pins: AlarmState["pins"] = {};
  const posts: string[] = [];
  for (const pin of PINNED_WORKAROUNDS) {
    const before = state?.pins[pin.event];
    const seen = healEvents.some(([event, count]) => event.startsWith(pin.event) && count > 0);
    const lastSeen = seen || !before ? window.to.toISOString() : before.lastSeen;
    const told = !seen && before?.told === true;
    const quietMs = window.to.getTime() - Date.parse(lastSeen);
    const post = !told && quietMs >= PIN_QUIET_DAYS * 86_400_000;
    if (post)
      posts.push(
        `✅ ${pin.post}. prd has logged no \`${pin.event}*\` since ${lastSeen.slice(0, 10)} (${PIN_QUIET_DAYS} days) ${onCallMention}`,
      );
    pins[pin.event] = { lastSeen, told: told || post };
  }
  return { pins, posts };
}

/** The logs a run at `now` reads. Workers Logs can land a minute or so after the event, so a run
 *  reads to two minutes ago; the next one starts there. Pure. */
export function logWindow(now: Date, state: AlarmState | null): LogWindow {
  const to = new Date(now.getTime() - 2 * 60_000);
  const from = state ? Date.parse(state.readUntil) : to.getTime() - 30 * 60_000;
  return { from: new Date(Math.max(from, to.getTime() - 24 * 3_600_000)), to };
}

/** The window's incidents: one per 5xx host, healed name or error message. Heals count only in a
 *  burst (10 or more in the window) or as an incident already open. Pure. */
function incidentsOf(reading: FaultReading, open: (key: string) => boolean) {
  const signals = [
    // prd answers no 5xx on purpose since #2844
    [
      "5xx responses",
      reading.serverErrors,
      (url: string) => url.replace(/^https?:\/\/([^/]+).*$/, "$1"),
    ],
    // a lone blip heals a call or three; 2026-09-23 ran ~1,800
    ["platform-failure heals", reading.heals, (name: string) => name],
    // every error is a page; expected ones are filtered in readWindow. A failed invocation's
    // summary is its request line: one incident per method and host, not per path — a scanner's
    // paths (2026-09-24: ~4,300 across 17 project hosts) would otherwise each open an incident.
    [
      "errors",
      reading.errors,
      (m: string) =>
        m
          .replace(/^([A-Z]+ https?:\/\/[^/?#\s]+)\S*$/, "$1/…")
          .replace(/reference = \w+/g, "reference = …")
          .slice(0, 80),
    ],
  ] as const;
  const incidents = new Map<string, { what: string; label: string; count: number }>();
  for (const [what, rows, label] of signals)
    for (const [raw, count] of rows) {
      const key = `${what}: ${label(raw)}`;
      const burst = rows.reduce((sum, [, n]) => sum + n, 0) >= 10;
      if (what === "platform-failure heals" && !burst && !open(key)) continue;
      const incident = incidents.get(key) ?? { what, label: label(raw), count: 0 };
      incidents.set(key, { ...incident, count: incident.count + count });
    }
  return incidents;
}

/**
 * What a window owes #error-pulse: one page for the incidents it opens (their thread is the page's,
 * filled in once posted) and one reply per thread for the open incidents it saw again, broadcast to
 * the channel once one grows tenfold since the channel last heard. Pure.
 */
export function triageIncidents(
  reading: FaultReading,
  window: LogWindow,
  state: AlarmState | null,
) {
  const open = Object.fromEntries(
    Object.entries(state?.incidents ?? {}).filter(
      ([, incident]) => Date.parse(incident.lastSeen) > window.to.getTime() - 24 * 3_600_000,
    ),
  );
  const seen = incidentsOf(reading, (key) => key in open);
  const incidents: AlarmState["incidents"] = { ...open };
  const opened: [string, { what: string; label: string; count: number }][] = [];
  const threads = new Map<string, { lines: string[]; broadcast: boolean }>();
  for (const [key, sighting] of seen) {
    const before = open[key];
    if (!before) {
      opened.push([key, sighting]);
      incidents[key] = {
        thread: "",
        lastSeen: window.to.toISOString(),
        count: sighting.count,
        told: sighting.count,
      };
      continue;
    }
    const count = before.count + sighting.count;
    const broadcast = count >= 10 * before.told;
    incidents[key] = {
      thread: before.thread,
      lastSeen: window.to.toISOString(),
      count,
      told: broadcast ? count : before.told,
    };
    const thread = threads.get(before.thread) ?? { lines: [], broadcast: false };
    thread.lines.push(
      `• ${sighting.count} more ${sighting.what}: ${sighting.label} (${count} in all)`,
    );
    thread.broadcast ||= broadcast;
    threads.set(before.thread, thread);
  }
  const span = `${hhmm(window.from)}–${hhmm(window.to)} UTC`;
  const pagers = Object.fromEntries(reading.pagers);
  // a pager's drop is logged with its outcome (apps/os context/rpc-stubs.ts `redialPager`)
  const pagersRedialed = pagers["rpc-stub-pager-redialed"] ?? 0;
  const pagersGaveUp = pagers["rpc-stub-pager-redial-failed"] ?? 0;
  const recovery =
    pagersRedialed + pagersGaveUp > 0 &&
    `• pagers in the window: ${pagersRedialed + pagersGaveUp} dropped, ${pagersRedialed} re-dialed, ${pagersGaveUp} gave up`;
  const page = opened.length
    ? {
        keys: opened.map(([key]) => key),
        text: renderFaultPage(
          opened.map(([, sighting]) => sighting),
          window,
          Boolean(state),
          recovery,
        ),
      }
    : null;
  const replies = [...threads].map(([thread, { lines, broadcast }]) => ({
    thread,
    broadcast,
    text: [
      broadcast ? `🚨 grew tenfold, ${span} ${onCallMention}` : `still failing, ${span}`,
      ...lines,
      recovery,
    ]
      .filter(Boolean)
      .join("\n"),
  }));
  return { page, replies, incidents };
}

/** The page opening `sightings`, biggest first per signal. Pure. */
function renderFaultPage(
  sightings: { what: string; label: string; count: number }[],
  window: LogWindow,
  remembered = true,
  recovery: string | false = false,
): string {
  const lines = ["5xx responses", "platform-failure heals", "errors"].map((what) => {
    const rows = sightings.filter((s) => s.what === what).sort((a, b) => b.count - a.count);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const top = rows.slice(0, 4).map((row) => `${row.label} ${row.count}`);
    return rows.length && `• ${total} ${what}: ${top.join(", ")}${rows.length > 4 ? ", …" : ""}`;
  });
  return [
    `🚨 prd fault page: ${hhmm(window.from)}–${hhmm(window.to)} UTC ${onCallMention}`,
    ...lines,
    recovery,
    `<https://dash.cloudflare.com/${PRD_ACCOUNT_ID}/workers-and-pages/observability|Workers Logs>`,
    remembered
      ? "Repeats go in this thread."
      : "No state from the last run: an incident already paged pages again.",
  ]
    .filter(Boolean)
    .join("\n");
}

function hhmm(date: Date) {
  return date.toISOString().slice(11, 16);
}

/** Cloudflare's own failure of a Workers Logs query: a 5xx, or an answer that is not JSON (its HTML
 *  error page). The message names the status, the content type and the answer's first 200 bytes. */
class CloudflarePlatformFailure extends Error {
  readonly status: number;
  constructor(response: Response, text: string) {
    super(
      `Workers Logs query answered HTTP ${response.status} (${response.headers.get("content-type") ?? "no content-type"}): ${text.slice(0, 200)}`,
    );
    this.status = response.status;
  }
}

/** A Workers Logs filter: a leaf, or a group combining its filters. */
export type LogFilter =
  | { key: string; operation: string; value?: string | number; type: "string" | "number" }
  | { kind: "group"; filterCombination: "and" | "or"; filters: LogFilter[] };

/** The filter every query leads with: the first-party prd Workers. */
const prdWorkers: LogFilter = {
  key: "$metadata.service",
  operation: "in",
  value: PRD_WORKERS.join(","),
  type: "string",
};

/** Cloudflare refuses a query whose filters pass 16 nodes, each leaf and each group one node and
 *  the top-level list none: "Filter expression is too complex; maximum is 16 filter nodes". Its API
 *  reference names only a nesting depth of 4. */
export const MAX_FILTER_NODES = 16;

export function filterNodes(filters: LogFilter[]): number {
  return filters.reduce(
    (nodes, filter) => nodes + 1 + ("filters" in filter ? filterNodes(filter.filters) : 0),
    0,
  );
}

/** An expected outcome a count drops: the rows whose `key` is one of `values` and that `keep`
 *  (filters every other row passes) rejects. `name` names it in the logs. */
export type Exclusion = { name: string; key: string; values: string[]; keep: LogFilter[] };

/**
 * The queries counting `base`'s rows except `exclusions`' rows: disjoint filter lists whose counts
 * add up, each within MAX_FILTER_NODES however many exclusions and values there are. Per key, one
 * part holds the rows whose key is null or none of the values, and one part per chunk of values
 * excluded by the same exclusions holds those rows under just those exclusions' `keep`; with two
 * keys, each part of one pairs with each part of the other. Row for row, that is the one query
 * ANDing each exclusion's
 * `or(key is_null, key not_in values, keep)`. A part still past MAX_FILTER_NODES is sent without
 * its last keeps, named in `dropped`: its expected rows may page, and a fault never hides. Pure.
 */
export function exclusionQueries(base: LogFilter[], exclusions: Exclusion[]) {
  let parts: { filters: LogFilter[]; keeps: Exclusion[] }[] = [{ filters: [], keeps: [] }];
  for (const key of new Set(exclusions.map((exclusion) => exclusion.key))) {
    const excludedBy = new Map<string, Exclusion[]>();
    for (const exclusion of exclusions.filter((exclusion) => exclusion.key === key))
      for (const value of exclusion.values)
        excludedBy.set(value, [...(excludedBy.get(value) ?? []), exclusion]);
    if (!excludedBy.size) continue;
    const alike = new Map<string, { keeps: Exclusion[]; values: string[] }>();
    for (const [value, keeps] of excludedBy) {
      const signature = JSON.stringify(keeps.map((exclusion) => exclusion.name));
      const values = alike.get(signature)?.values ?? [];
      alike.set(signature, { keeps, values: [...values, value] });
    }
    const notIn = chunks([...excludedBy.keys()]).map((chunk): LogFilter => ({
      key,
      operation: "not_in",
      value: chunk.join(","),
      type: "string",
    }));
    const keyParts: typeof parts = [
      {
        filters: [
          {
            kind: "group",
            filterCombination: "or",
            filters: [
              { key, operation: "is_null", type: "string" },
              notIn.length === 1
                ? notIn[0]!
                : { kind: "group", filterCombination: "and", filters: notIn },
            ],
          },
        ],
        keeps: [],
      },
      ...[...alike.values()].flatMap(({ keeps, values }) =>
        chunks(values).map((chunk) => ({
          filters: [{ key, operation: "in", value: chunk.join(","), type: "string" } as const],
          keeps,
        })),
      ),
    ];
    parts = parts.flatMap((part) =>
      keyParts.map((keyPart) => ({
        filters: [...part.filters, ...keyPart.filters],
        keeps: [...part.keeps, ...keyPart.keeps],
      })),
    );
  }
  return parts.map(({ filters, keeps }) => {
    const kept = [...keeps];
    const dropped: string[] = [];
    const query = () => [...base, ...filters, ...kept.flatMap((exclusion) => exclusion.keep)];
    // readWindow's `query` leads every query with prdWorkers
    while (kept.length && filterNodes([prdWorkers, ...query()]) > MAX_FILTER_NODES)
      dropped.unshift(kept.pop()!.name);
    return { filters: query(), dropped };
  });
}

/** `values` in the lists one `in` or `not_in` takes: 500, well under the thousands at which
 *  Cloudflare answers "Internal error". */
function chunks(values: string[]) {
  const chunked: string[][] = [];
  for (let start = 0; start < values.length; start += 500)
    chunked.push(values.slice(start, start + 500));
  return chunked;
}

/**
 * Expected outcomes dropped by their ray: in the ray of an `event` info line, the rows `keep`
 * rejects. `serverErrors`: the 5xx count drops them too, not only the errors.
 *
 * Two expression-fetch answers are 5xx on purpose, each logged at info by the context DO that
 * answered (apps/os iterate-context-durable-object.ts): a fetch route whose target is an offline
 * lent stub (`iterate tunnel` killed without Ctrl-C) answers 502, the upstream's absence, logged
 * `expression-fetch.rpc-stub-offline`, and a Vite tab left open re-requests it every second; a
 * deploy that reset a context the fetch dialed, when the hop could not send it again (a request
 * with a body), answers 503, logged `expression-fetch.deploy-reset`. Each hop of such a request
 * logs its own summary at error level under its own requestId: the project host's Worker, the
 * context DO's fetch, the ItxEntrypoint of the config worker's `env.ITX.fetch`, and the DO's fetch
 * again. The loaded config worker starts a new traceId, so only the edge's rayId joins all four to
 * the info line. `keep` rejects only a summary of the answer's status: another status, another
 * event or another ray still pages.
 *
 * A visitor whose connection to a tunnel's WebSocket vanished without a close frame (a laptop
 * asleep, a network gone): the edge logs `fetch-upgrade.local-gone` at info, and the runtime fails
 * that invocation — its pump of the visitor's socket read a dead connection — with "Network
 * connection lost." and an exception summary in the same ray (apps/os
 * context/fetch-upgrade-splice.ts). Those two go; any other error in the ray still pages.
 */
type RayExclusion = { event: string; serverErrors: boolean; keep: LogFilter[] };
export const RAY_EXCLUSIONS: RayExclusion[] = [
  ...[
    { event: "expression-fetch.rpc-stub-offline", status: 502 },
    { event: "expression-fetch.deploy-reset", status: 503 },
  ].map(({ event, status }): RayExclusion => ({
    event,
    serverErrors: true,
    keep: [
      {
        kind: "group",
        filterCombination: "or",
        filters: [
          { key: "$metadata.type", operation: "is_null", type: "string" },
          { key: "$metadata.type", operation: "neq", value: "cf-worker-event", type: "string" },
          { key: "$workers.event.response.status", operation: "is_null", type: "number" },
          {
            key: "$workers.event.response.status",
            operation: "neq",
            value: status,
            type: "number",
          },
        ],
      },
    ],
  })),
  {
    event: "fetch-upgrade.local-gone",
    serverErrors: false,
    keep: [
      {
        kind: "group",
        filterCombination: "or",
        filters: [
          { key: "$metadata.type", operation: "neq", value: "cf-worker", type: "string" },
          {
            key: "$metadata.message",
            operation: "neq",
            value: "Network connection lost.",
            type: "string",
          },
        ],
      },
      {
        kind: "group",
        filterCombination: "or",
        filters: [
          { key: "$metadata.type", operation: "neq", value: "cf-worker-event", type: "string" },
          { key: "$workers.outcome", operation: "neq", value: "exception", type: "string" },
        ],
      },
    ],
  },
];

/** A deploy reset's error summaries, by the request IDs deployResetSummaries proves: the Durable
 *  Object's cf-worker-event rows under them. */
export const DEPLOY_RESET_SUMMARIES = {
  name: "deploy-reset-summaries",
  key: "$metadata.requestId",
  keep: [
    {
      kind: "group",
      filterCombination: "or",
      filters: [
        { key: "$workers.executionModel", operation: "is_null", type: "string" },
        {
          key: "$workers.executionModel",
          operation: "neq",
          value: "durableObject",
          type: "string",
        },
        { key: "$metadata.type", operation: "is_null", type: "string" },
        { key: "$metadata.type", operation: "neq", value: "cf-worker-event", type: "string" },
      ],
    },
  ],
} satisfies Omit<Exclusion, "values">;

async function readWindow(
  window: LogWindow,
  { accountId, apiToken }: CloudflareCredentials,
  delaysMs: readonly number[],
): Promise<FaultReading> {
  // One grouped count per signal: one query, or with exclusions several over disjoint rows
  // (exclusionQueries). Its rows sum to a lower bound (events without the grouped field, or past
  // 2,000 groups in a query, drop out) — a burst still pages.
  //
  // A query only reads, so one that Cloudflare itself failed (CloudflarePlatformFailure, or a
  // dropped connection) is asked again after each of `delaysMs`, with a
  // `prd-fault-alarm.platform-failure-retry` warn per repeat; the last failure fails the run. A JSON
  // answer below 500 is Cloudflare's answer about the query: a broken token (success: false) or a
  // renamed field fails the run at once, never reads as a quiet prd.
  const query = (view: "calculations" | "events", filters: LogFilter[], parameters: object) =>
    retryPlatformFailures(
      async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
          {
            method: "POST",
            signal: AbortSignal.timeout(30_000), // one bounded read; classification failures keep the original page
            headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
            body: JSON.stringify({
              queryId: "prd-fault-alarm",
              view,
              ...(view === "events" && { limit: 100 }),
              timeframe: { from: window.from.getTime(), to: window.to.getTime() },
              parameters: {
                datasets: ["cloudflare-workers"],
                ...parameters,
                filters: [prdWorkers, ...filters],
              },
            }),
          },
        );
        const text = await response.text();
        if (response.status >= 500) throw new CloudflarePlatformFailure(response, text);
        let answer: unknown;
        try {
          answer = JSON.parse(text);
        } catch {
          throw new CloudflarePlatformFailure(response, text);
        }
        const body = z
          .object({
            success: z.boolean(),
            errors: z.unknown().optional(),
            result: z.unknown().optional(),
          })
          .parse(answer);
        if (!body.success)
          throw new Error(`Workers Logs query failed: ${JSON.stringify(body.errors)}`);
        return body.result;
      },
      {
        event: "prd-fault-alarm.platform-failure-retry",
        delaysMs,
        // fetch rejects with a TypeError when the connection fails; a timeout is thrown as it is.
        platformFailure: (error) =>
          error instanceof TypeError
            ? { view, status: "network", message: error.message }
            : error instanceof CloudflarePlatformFailure
              ? { view, status: error.status, message: error.message }
              : undefined,
      },
    );
  // Without `groupBy`, one row: ["", the total].
  const rows = async (filters: LogFilter[], groupBy?: string): Promise<[string, number][]> => {
    const result = z
      .object({
        calculations: z
          .array(
            z.object({
              aggregates: z.array(
                z.object({ groupKey: z.string().default(""), count: z.number() }),
              ),
            }),
          )
          .min(1),
      })
      .parse(
        await query("calculations", filters, {
          calculations: [{ operator: "count" }],
          groupBys: groupBy ? [{ type: "string", value: groupBy }] : [],
          orderBy: { value: "count", order: "desc" },
          limit: 2000,
        }),
      );
    return result.calculations[0]!.aggregates.map((row) => [row.groupKey, row.count]);
  };
  const count = async (base: LogFilter[], exclusions: Exclusion[], groupBy?: string) => {
    const parts = exclusionQueries(base, exclusions);
    const counted = new Map<string, number>();
    const found = await Promise.all(parts.map(({ filters }) => rows(filters, groupBy)));
    for (const [index, { dropped }] of parts.entries()) {
      const partRows = found[index]!;
      for (const [key, n] of partRows) counted.set(key, (counted.get(key) ?? 0) + n);
      // A part without rows lost nothing to its dropped keeps.
      const total = partRows.reduce((sum, [, n]) => sum + n, 0);
      if (dropped.length && total)
        console.warn(
          JSON.stringify({ event: "prd-fault-alarm.exclusion-dropped", dropped, rows: total }),
        );
    }
    return [...counted].sort(([, a], [, b]) => b - a);
  };
  // A read of an exclusion's rays that is capped (2,000 groups) or failed excludes nothing: it can
  // only remove noise, never lose an observed fault. So does one whose rays, added to those before
  // it, reach 2,000: the most a count's four `not_in` of rays can hold beside its own filters.
  const rayEvidence = await Promise.all(
    RAY_EXCLUSIONS.map(({ event }) =>
      rows(
        [{ key: "event", operation: "eq", value: event, type: "string" }],
        "$metadata.rayId",
      ).then(
        (found) => found.map(([rayId]) => rayId).filter(Boolean),
        (error: unknown) => {
          console.warn(
            JSON.stringify({
              event: "prd-fault-alarm.exclusion-evidence-failed",
              exclusion: event,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return [];
        },
      ),
    ),
  );
  let excludedRays = 0;
  const rayExclusions = RAY_EXCLUSIONS.map((exclusion, index) => {
    const rays = rayEvidence[index]!;
    const capped = excludedRays + rays.length >= 2000;
    console.log(
      JSON.stringify({
        event: "prd-fault-alarm.exclusion-evidence",
        exclusion: exclusion.event,
        rays: rays.length,
        capped,
      }),
    );
    if (!capped) excludedRays += rays.length;
    return {
      ...exclusion,
      name: exclusion.event,
      key: "$metadata.rayId",
      values: capped ? [] : rays,
    };
  });
  // Every 5xx pages, so they are counted twice: by URL, and in all. The ones the URL rows miss
  // (no URL logged, or past 2,000 groups) page as `unknown`.
  const readServerErrors = async () => {
    const status: LogFilter[] = [
      { key: "$workers.event.response.status", operation: "gte", value: 500, type: "number" },
    ];
    const answers = rayExclusions.filter((exclusion) => exclusion.serverErrors);
    const [byUrl, all] = await Promise.all([
      count(status, answers, "$workers.event.request.url"),
      count(status, answers),
    ]);
    const missed = (all[0]?.[1] ?? 0) - byUrl.reduce((sum, [, n]) => sum + n, 0);
    return missed > 0 ? [...byUrl, ["unknown", missed] satisfies [string, number]] : byUrl;
  };
  // workerd#918: a Durable Object that answers before a request body is read can log
  // "Can't read from request stream after response has been sent." though the client got its
  // response. Scanners POSTing to project hosts raise it on ~3 % of chunked bodies even with the
  // itx-expression fetch's pipe (#2871; the #2880 follow-up measured no effect). It pages only on `/api`
  // itself — the capnweb endpoint, a platform call, not a site visit (`/api/…` is a site's path).
  const unreadBody = "Can't read from request stream after response has been sent";
  // reportIssue logs an error object without a message. Cloudflare puts it in $metadata.error.
  // Read the two fields with the same policy, using error only when message is absent or empty.
  const readErrors = async (
    key: "$metadata.message" | "$metadata.error",
    filters: LogFilter[],
    exclusions: Exclusion[],
  ) => {
    const common: LogFilter[] = [
      { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
      { key, operation: "neq", value: "", type: "string" },
      ...filters,
    ];
    const [errors, apiUnreadBodyErrors] = await Promise.all([
      count(
        [
          ...common,
          ...[
            "itx.abort() reset the context", // explicitly requested, recorded in the durable log
            unreadBody,
            "Durable Object reset because its code was updated", // expected deploy cancellation
          ].map((value): LogFilter => ({ key, operation: "not_includes", value, type: "string" })),
        ],
        exclusions,
        key,
      ),
      count(
        [
          ...common,
          { key, operation: "includes", value: unreadBody, type: "string" },
          {
            key: "$workers.event.request.url",
            operation: "regex",
            value: "^https?://[^/]+/api(\\?|$)",
            type: "string",
          },
        ],
        exclusions,
        key,
      ),
    ]);
    return [...errors, ...apiUnreadBodyErrors];
  };
  const healed: LogFilter[] = [
    { key: "event", operation: "includes", value: "platform-failure", type: "string" },
  ];
  const [serverErrors, heals, healEvents, initialErrors, structuredErrors, pagers] =
    await Promise.all([
      readServerErrors(),
      rows(healed, "name"),
      rows(healed, "event"),
      readErrors("$metadata.message", [], rayExclusions),
      readErrors(
        "$metadata.error",
        [
          {
            kind: "group",
            filterCombination: "or",
            filters: [
              { key: "$metadata.message", operation: "is_null", type: "string" },
              { key: "$metadata.message", operation: "eq", value: "", type: "string" },
            ],
          },
        ],
        rayExclusions,
      ),
      rows(
        [{ key: "event", operation: "includes", value: "rpc-stub-pager-", type: "string" }],
        "event",
      ),
    ]);
  let errors = initialErrors;
  if (errors.length) {
    try {
      const result = z.object({ events: z.object({ events: z.array(WorkerErrorEvent) }) }).parse(
        await query(
          "events",
          [
            { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
            {
              key: "$workers.executionModel",
              operation: "eq",
              value: "durableObject",
              type: "string",
            },
          ],
          {},
        ),
      );
      // A capped read is incomplete evidence: keep the original alarm. Re-count while excluding
      // only identified summaries; subtracting counts across queries could erase a different error
      // if the reset arrived in Workers Logs between the count and the evidence read.
      console.log(
        JSON.stringify({
          event: "prd-fault-alarm.reset-evidence",
          count: result.events.events.length,
          capped: result.events.events.length >= 100,
        }),
      );
      if (result.events.events.length < 100) {
        const expected = deployResetSummaries(result.events.events);
        if (expected.size) {
          // Listed before the rays' exclusions, so a part too big for both keeps this one: it
          // drops a reset's summary in an expected answer's ray whatever status the summary has.
          errors = await readErrors(
            "$metadata.message",
            [],
            [{ ...DEPLOY_RESET_SUMMARIES, values: [...expected] }, ...rayExclusions],
          );
          console.log(
            JSON.stringify({
              event: "prd-fault-alarm.deploy-reset-summaries",
              requestIds: [...expected],
            }),
          );
        }
      }
    } catch (error) {
      // This query can only remove noise. Losing its evidence must never lose an observed fault.
      console.warn(
        JSON.stringify({
          event: "prd-fault-alarm.reset-classification-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return {
    serverErrors,
    heals,
    healEvents,
    errors: [...errors, ...structuredErrors],
    pagers,
  };
}

const WorkerErrorEvent = z.object({
  timestamp: z.number(),
  $metadata: z.object({
    type: z.string().nullish(),
    requestId: z.string().nullish(),
    message: z.string().nullish(),
    error: z.string().nullish(),
  }),
  $workers: z.object({
    durableObjectId: z.string().nullish(),
    scriptVersion: z.object({ id: z.string().nullish() }).nullish(),
    executionModel: z.string().nullish(),
    outcome: z.string().nullish(),
    truncated: z.boolean().nullish(),
  }),
});

/** The runtime logs BOTH the deploy-reset exception and an error invocation summary ("GET …",
 *  "IterateContextDurableObject.jsrpc"). The message filter removes only the former. Correlate
 *  the latter with its DO, version and exact reset millisecond. Cloudflare can repeat one reset's
 *  requestId on multiple exceptions (2026-09-24 10:30:06.305 and 11:41:21.252), so requestId alone
 *  misses its other cancelled calls. Any unexplained line in that group keeps ALL its summaries;
 *  a missing identity or truncated invocation is not evidence. HTTP 5xx counts are untouched.
 *  This classifies deploy cancellation, not successful recovery of a background caller. */
export function deployResetSummaries(events: z.infer<typeof WorkerErrorEvent>[]) {
  const groups = new Map<string, z.infer<typeof WorkerErrorEvent>[]>();
  for (const event of events) {
    const worker = event.$workers;
    if (
      worker.executionModel !== "durableObject" ||
      !worker.durableObjectId ||
      !worker.scriptVersion?.id
    )
      continue;
    const key = JSON.stringify([worker.durableObjectId, worker.scriptVersion.id, event.timestamp]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const proven = new Set<z.infer<typeof WorkerErrorEvent>>();
  for (const group of groups.values()) {
    const exceptions = group.filter((event) => event.$metadata.type !== "cf-worker-event");
    if (
      group.some((event) => !event.$metadata.type || event.$workers.truncated) ||
      !exceptions.length ||
      !exceptions.every((event) => {
        const texts = [event.$metadata.message, event.$metadata.error].filter(Boolean);
        return (
          texts.length &&
          texts.every((text) => text === "Durable Object reset because its code was updated.")
        );
      })
    )
      continue;
    for (const event of group) {
      const { type, requestId } = event.$metadata;
      if (type === "cf-worker-event" && event.$workers.outcome === "exception" && requestId)
        proven.add(event);
    }
  }
  const expected = new Set([...proven].map((event) => event.$metadata.requestId!));
  // A request ID observed on another summary is ambiguous: never exclude that other invocation.
  for (const event of events) {
    if (
      event.$metadata.type === "cf-worker-event" &&
      event.$metadata.requestId &&
      !proven.has(event)
    )
      expected.delete(event.$metadata.requestId);
  }
  return expected;
}

/** The newest main run's state, written to `out`; nothing when no run of the last 20 kept one. */
export async function previousState(options: { out: string }) {
  return saveNewestArtifactFile({ ...stateArtifact, out: options.out });
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-fault-alarm" }).run();
