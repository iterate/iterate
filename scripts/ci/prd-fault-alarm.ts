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
// is all it takes to be alarmed.
//
//   doppler run --project os --config prd -- pnpm tsx scripts/ci/prd-fault-alarm.ts run
//   … run --at 2026-09-23T07:30:00Z --dry-run    # replay the half hour to then, post nothing
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
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
import { newestArtifactFile } from "./depot.ts";
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
 *  close (apps/os context/rpc-stubs.ts); one that gives up logs an error, which is. */
export type FaultReading = Record<
  "serverErrors" | "heals" | "errors" | "pagers",
  [string, number][]
>;

/** The logs one run reads: from where the last run stopped to now. */
export type LogWindow = { from: Date; to: Date };

/** What the alarm remembers between runs. `readUntil` is where the next read starts; each open
 *  incident, by its key, holds the thread of the page that opened it, how often it was seen and the
 *  count the channel last heard. */
export const AlarmState = z.object({
  readUntil: z.string(),
  incidents: z.record(
    z.string(),
    z.object({ thread: z.string(), lastSeen: z.string(), count: z.number(), told: z.number() }),
  ),
});
export type AlarmState = z.infer<typeof AlarmState>;

/** Reads the prd Workers' Logs since the last run and pages #error-pulse on a fault. */
export async function run(
  options: { at?: string; dryRun?: boolean; state?: string; stateOut?: string } = {},
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
  // again and posts what this one owed.
  if (options.stateOut && !options.at && !options.dryRun) {
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
}) {
  const { window } = input;
  const reading = await readWindow(window, input.cloudflare);
  console.log(JSON.stringify({ window, reading }));
  const triage = triageIncidents(reading, window, input.state);
  // Only a run that owes a post needs Slack: a quiet run stays green whatever its token does.
  const slack = triage.page || triage.replies.length ? input.slack?.() : undefined;
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
  const summary = [triage.page?.text, ...triage.replies.map((reply) => reply.text)]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: summary || "prd is quiet",
    next: { readUntil: window.to.toISOString(), incidents } satisfies AlarmState,
  };
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
    // every error is a page; expected ones are filtered in readWindow
    [
      "errors",
      reading.errors,
      (m: string) => m.replace(/reference = \w+/g, "reference = …").slice(0, 80),
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
  const recovery =
    (pagers["rpc-stub-pager-dropped"] ?? 0) > 0 &&
    `• pagers in the window: ${pagers["rpc-stub-pager-dropped"]} dropped, ${pagers["rpc-stub-pager-redialed"] ?? 0} re-dialed, ${pagers["rpc-stub-pager-redial-failed"] ?? 0} gave up`;
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

async function readWindow(
  window: LogWindow,
  { accountId, apiToken }: CloudflareCredentials,
): Promise<FaultReading> {
  // One grouped count per signal. Its rows sum to a lower bound (events without the grouped field,
  // or past 2,000 groups, drop out) — a burst still pages.
  const query = async (view: "calculations" | "events", filters: object[], parameters: object) => {
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
            filters: [
              {
                key: "$metadata.service",
                operation: "in",
                value: PRD_WORKERS.join(","),
                type: "string",
              },
              ...filters,
            ],
          },
        }),
      },
    );
    const body = z
      .object({
        success: z.boolean(),
        errors: z.unknown().optional(),
        result: z.unknown().optional(),
      })
      .parse(await response.json());
    // A broken token or a renamed field must fail the run, never read as a quiet prd.
    if (!body.success) throw new Error(`Workers Logs query failed: ${JSON.stringify(body.errors)}`);
    return body.result;
  };
  // Without `groupBy`, one row: ["", the total].
  const rows = async (filters: object[], groupBy?: string): Promise<[string, number][]> => {
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
  // Every 5xx pages, so they are counted twice: by URL, and in all. The ones the URL rows miss
  // (no URL logged, or past 2,000 groups) page as `unknown`.
  const readServerErrors = async () => {
    const status = [
      { key: "$workers.event.response.status", operation: "gte", value: 500, type: "number" },
    ];
    const [byUrl, all] = await Promise.all([
      rows(status, "$workers.event.request.url"),
      rows(status),
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
    filters: object[] = [],
  ) => {
    const common = [
      { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
      { key, operation: "neq", value: "", type: "string" },
      ...filters,
    ];
    const [errors, apiUnreadBodyErrors] = await Promise.all([
      rows(
        [
          ...common,
          ...[
            "itx.abort() reset the context", // explicitly requested, recorded in the durable log
            unreadBody,
            "Durable Object reset because its code was updated", // expected deploy cancellation
          ].map((value) => ({ key, operation: "not_includes", value, type: "string" })),
        ],
        key,
      ),
      rows(
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
        key,
      ),
    ]);
    return [...errors, ...apiUnreadBodyErrors];
  };
  const [serverErrors, heals, initialErrors, structuredErrors, pagers] = await Promise.all([
    readServerErrors(),
    rows(
      [{ key: "event", operation: "includes", value: "platform-failure", type: "string" }],
      "name",
    ),
    readErrors("$metadata.message"),
    readErrors("$metadata.error", [
      {
        kind: "group",
        filterCombination: "or",
        filters: [
          { key: "$metadata.message", operation: "is_null", type: "string" },
          { key: "$metadata.message", operation: "eq", value: "", type: "string" },
        ],
      },
    ]),
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
          errors = await readErrors("$metadata.message", [
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
                { key: "$metadata.requestId", operation: "is_null", type: "string" },
                {
                  key: "$metadata.type",
                  operation: "neq",
                  value: "cf-worker-event",
                  type: "string",
                },
                {
                  key: "$metadata.requestId",
                  operation: "not_in",
                  value: [...expected].join(","),
                  type: "string",
                },
              ],
            },
          ]);
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
  const state = await newestArtifactFile({
    repository: process.env.GITHUB_REPOSITORY || "iterate/iterate",
    ...stateArtifact,
  });
  if (!state) return "no previous state";
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, state);
  return `previous state: ${state.length} bytes`;
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-fault-alarm" }).run();
