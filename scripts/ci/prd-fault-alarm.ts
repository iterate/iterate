// Prd fault alarm (prd-fault-alarm.yml, every 15 minutes): reads the first-party prd Workers' Logs
// since its last run and pages #error-pulse on a 5xx a visitor was answered, a burst of
// platform-failure heals, or an error. It reads the logs because the platform's recovery can keep
// most requests green through a Cloudflare fault, so the heals and errors it logs are the only sign.
//
// Each fault is an incident, keyed by its cause: a deploy's reset or version skew in a Worker, a
// visitor 5xx's host, a healed facet's name or an error message. The incidents a run opens share
// one page (slack.ts pageText), which later runs edit in place with each incident's running count
// and when it was last seen. The page's thread hears only of a change of state, each reply
// mentioning Jonas and Misha: an incident grown tenfold or back in a burst after an hour's quiet
// (both broadcast to the channel), and the page's resolution once its last incident has gone a day
// unseen. An incident seen after it closed opens a new page.
//
// The memory is the run's `prd-fault-alarm-state` artifact: where the next read starts, and the
// open pages with their incidents. Only a run on main posts and keeps it; any other run prints what
// it would post. A run without a state it can parse reads the last half hour and pages everything as
// new: a repeat, never a miss.
//
// A workaround that heals a platform fault logs `console.warn({ event:
// "<area>.platform-failure-<action>", name, … })` (apps/os context/facet-host.ts); naming it so
// is all it takes to be alarmed. One whose defect is too rare to pin with a failing test is pinned
// here instead (PINNED_WORKAROUNDS): the alarm posts once when its heal has been absent for weeks.
// A Cloudflare defect that only logs an error line, where no call failed, is pinned by a test and
// listed in PINNED_LINES with where its line still pages.
//
//   node scripts/ci/prd-fault-alarm.ts run   # prd's Cloudflare API token from Doppler _shared/prd
//   … run --ref <git ref> --state <previous.json> --state-out <next.json>   # posts and keeps state on main only
//   … run --at 2026-09-23T07:30:00Z --dry-run    # replay the half hour to then, post nothing
//   … run --at 2026-09-23T07:30:00Z --test-run   # post that half hour's page to #ci as 🧪, keep nothing
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import {
  CI_HTTP,
  HttpAnswerError,
  httpFailureFields,
  httpFailureKind,
  retryPlatformFailures,
} from "@iterate-com/shared/platform-retry";
import {
  adminEnvs,
  agentsEnvs,
  cloudflareAccounts,
  dashEnvs,
  docsEnvs,
  kitEnvs,
  notesEnvs,
  osEnvs,
  PRD_ACCOUNT_ID,
  spaEnvs,
  voiceEnvs,
} from "../../envs.ts";
import { dopplerSecret } from "../lib/env-context.ts";
import { depotApi, saveNewestArtifactFile } from "./depot.ts";
import {
  editPage,
  escalationText,
  getSlackClient,
  onCallMention,
  pageChannel,
  pageText,
  resolvePage,
  slackEscape,
} from "./slack.ts";

/** Every first-party Worker in production: the platform and its clients. A 5xx or an error in any
 *  of them pages, a client's as much as the platform's. */
const PRD_WORKERS = [
  osEnvs.prd!,
  dashEnvs.prd,
  agentsEnvs.prd,
  notesEnvs.prd,
  docsEnvs.prd,
  adminEnvs.prd,
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

/** The account's Workers Logs API access. */
export type CloudflareCredentials = { accountId: string; apiToken: string };

/** One window's rows per signal: [label, count], biggest first. `serverErrors` are the 5xx
 *  visitors were answered, by URL, outside a cause's rays; `causes` holds those inside them. `pagers`
 *  is not a fault: the rpc-stub pagers' re-dial outcomes by event, which say whether a Durable
 *  Object's close was recovered (apps/os context/rpc-stub-relay.ts); one that gives up logs an
 *  error, which is. `closeResets` are the errors a context's socket close logged for a reset
 *  (CLOSE_RESET), by message: errors only when that recovery did not hold. `healEvents` is `heals`
 *  by event instead of by name, for PINNED_WORKAROUNDS. */
export type FaultReading = Record<
  "serverErrors" | "heals" | "healEvents" | "errors" | "closeResets" | "pagers",
  [string, number][]
> & { causes: CauseReading[] };

/** The visitor 5xx, by URL, in the rays a deploy's reset or version skew reached. `worker` is the
 *  Worker that logged the cause: every deploy of it, and the old and new versions each deploy
 *  runs side by side, are one incident while it lasts. */
export type CauseReading = { cause: Cause; worker: string; serverErrors: [string, number][] };

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
  // The Worker Loader defect at facet start (https://github.com/iterate/alarm-loader-facet-repro),
  // healed at both of its call sites; worker-loader.ts `retire` serves both, and goes with the last.
  {
    event: "facet.platform-failure-",
    post: "Cloudflare seems to have fixed the Worker Loader defect at facet start: delete the restart in apps/os/src/context/facet-host.ts (`isFacetStartPlatformFailure`)",
  },
  {
    event: "workers.platform-failure-",
    post: "Cloudflare seems to have fixed the Worker Loader clone-version defect in workers.get: delete its retire and replay in apps/os/src/context/built-ins.ts",
  },
];
export const PIN_QUIET_DAYS = 28;

/** The logs one run reads: from where the last run stopped to now. */
export type LogWindow = { from: Date; to: Date };

const HOUR_MS = 3_600_000;
/** An incident unseen this long closes; a page whose incidents have all closed is resolved. */
const CLOSE_AFTER_MS = 24 * HOUR_MS;
/** An incident unseen this long (four windows) is quiet: the page says so. Its return in a burst
 *  is a change of state the channel hears, at most once per BACK_EVERY_MS; a sporadic error's next
 *  lone sighting only edits the page. */
const QUIET_AFTER_MS = HOUR_MS;
const BACK_EVERY_MS = 6 * HOUR_MS;
/** A burst: this many sightings in one window. A lone blip heals a call or three (2026-09-23 ran
 *  ~1,800 heals); a sporadic error recurs one at a time. */
const BURST = 10;

/** One open or closed incident on a page. `told` is the count the channel last heard; `back` when
 *  the channel last heard it was back after a quiet hour. `hosts` are a cause's visitor 5xx by host. */
const Incident = z.object({
  what: z.string(),
  label: z.string(),
  count: z.number(),
  told: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  back: z.string().nullable(),
  closed: z.boolean(),
  hosts: z.record(z.string(), z.number()),
});
type Incident = z.infer<typeof Incident>;

/** A page as posted: its message's ts, its text as last posted or edited, and its incidents. */
const Page = z.object({
  ts: z.string(),
  text: z.string(),
  incidents: z.record(z.string(), Incident),
});
type Page = z.infer<typeof Page>;

/** What the alarm remembers between runs. `readUntil` is where the next read starts; `pages` the
 *  pages still open. Each pinned workaround, by its event, holds when prd last logged its heal (or
 *  when the count started) and whether its post went out. */
export const AlarmState = z.object({
  readUntil: z.string(),
  pages: z.array(Page),
  pins: z.record(z.string(), z.object({ lastSeen: z.string(), told: z.boolean() })),
});
export type AlarmState = z.infer<typeof AlarmState>;

/** The previous run's state, or null when there is none or it does not parse (a state of an older
 *  shape): the run then starts over, which may repeat a page once and never misses one. */
export function readState(path: string | undefined): AlarmState | null {
  if (!path || !existsSync(path)) return null;
  let previous: unknown;
  try {
    previous = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A truncated or corrupt file is a state this alarm cannot read, like one of another shape.
  }
  const parsed = AlarmState.safeParse(previous);
  if (parsed.success) return parsed.data;
  console.log(`[prd-fault-alarm] ${path} is not a state this alarm reads: starting over`);
  return null;
}

/** Reads the prd Workers' Logs since the last run and pages #error-pulse on a fault. Only a run on
 *  main (`ref`, the run's git ref) posts and keeps its state: any other run prints what it would
 *  post, so a dispatch on a branch never moves main's read window or its pages. `testRun` posts the
 *  window's would-be page to #ci as a 🧪 TEST RUN, from no state and keeping none. */
export async function run(
  options: {
    at?: string;
    dryRun?: boolean;
    testRun?: boolean;
    ref?: string;
    state?: string;
    stateOut?: string;
  } = {},
) {
  const account = cloudflareAccounts.prd;
  const cloudflare = {
    accountId: account.cloudflareAccountId,
    apiToken: dopplerSecret(account.dopplerProject, account.dopplerConfig, "CLOUDFLARE_API_TOKEN"),
  };
  const mode = runMode(options);
  const state = mode.readsState ? readState(options.state) : null;
  const outcome = await alarm({
    window: options.at
      ? { from: new Date(Date.parse(options.at) - 30 * 60_000), to: new Date(options.at) }
      : logWindow(new Date(), state),
    state,
    cloudflare,
    slack: mode.posts ? getSlackClient : null,
    testRun: mode.testRun,
  });
  // After every post: a run that failed to post keeps no state, so the next one reads its window
  // again and posts what this one owed.
  if (options.stateOut && mode.keeps) {
    mkdirSync(dirname(options.stateOut), { recursive: true });
    writeFileSync(options.stateOut, `${JSON.stringify(outcome.next, null, 2)}\n`);
  }
  return outcome.summary;
}

/** What a run may do. Only a run on main (`ref`) posts to #error-pulse and keeps its state, and not
 *  a replay (`at`) or a dry run. A test run posts to #ci and keeps nothing. A replay and a test run
 *  read their own half hour, from no state; any other run reads the state, so a run that only
 *  prints shows the edits and replies main would make. Pure. */
export function runMode(options: {
  at?: string;
  dryRun?: boolean;
  testRun?: boolean;
  ref?: string;
}) {
  const testRun = Boolean(options.testRun);
  const keeps = options.ref === "refs/heads/main" && !options.at && !options.dryRun && !testRun;
  return { testRun, keeps, posts: keeps || testRun, readsState: !options.at && !testRun };
}

/**
 * Reads `window` (logWindow) and makes #error-pulse (#ci for `testRun`) what triageIncidents says:
 * edits, thread replies and a new page. `slack: null` posts nothing. It resolves to what it posted
 * (or would post) and the next state, so a paged run ends green: a scheduled run reports on main's
 * head commit, where red reads as "this commit broke". It throws only when it could not read prd
 * (readWorkersFaultWindow) or post (the Slack client throws on an error).
 */
export async function alarm(input: {
  window: LogWindow;
  state: AlarmState | null;
  cloudflare: CloudflareCredentials;
  slack: (() => WebClient) | null;
  testRun: boolean;
}) {
  const { window, testRun } = input;
  const reading = await readWorkersFaultWindow(window, input.cloudflare);
  console.log(JSON.stringify({ window, reading }));
  const triage = triageIncidents(reading, window, input.state, testRun);
  // A test run shows the page alone: the pins keep their state on main.
  const pinned = testRun
    ? { pins: {}, posts: [] }
    : pinnedWorkarounds(reading.healEvents, window, input.state);
  // Only a run that owes a post needs Slack: a quiet run stays green whatever its token does.
  const owed =
    triage.page ||
    triage.updates.length > 0 ||
    triage.resolved.length > 0 ||
    pinned.posts.length > 0;
  const slack = owed ? input.slack?.() : undefined;
  const channel = pageChannel(testRun);
  const pages = triage.pages;
  for (const update of triage.updates) {
    let ts = update.ts;
    if (update.text && slack) ts = await editPage(slack, { channel, ts, text: update.text });
    const page = pages.find((open) => open.ts === update.ts);
    if (page) page.ts = ts;
    if (update.reply)
      await slack?.chat.postMessage({
        channel,
        thread_ts: ts,
        text: update.reply.text,
        reply_broadcast: update.reply.broadcast,
      });
  }
  for (const page of triage.resolved) if (slack) await resolvePage(slack, { channel, ...page });
  if (triage.page && slack) {
    const posted = await slack.chat.postMessage({ channel, text: triage.page.text });
    // The client throws on an error, and every posted message has its ts.
    pages.push({ ts: posted.ts!, text: triage.page.text, incidents: triage.page.incidents });
  }
  for (const text of pinned.posts) await slack?.chat.postMessage({ channel, text });
  const summary = [
    triage.page?.text,
    ...triage.updates.flatMap((update) => [
      update.text && `edit ${update.ts}:\n${update.text}`,
      update.reply && `reply in ${update.ts}:\n${update.reply.text}`,
    ]),
    ...triage.resolved.map((page) => `resolve ${page.ts}: ${page.why}`),
    ...pinned.posts,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: summary || "prd is quiet",
    next: {
      readUntil: window.to.toISOString(),
      pages,
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

/** A sighting of one incident in a window. */
type Sighting = Pick<Incident, "what" | "label" | "count" | "hosts">;

/** Errors a Durable Object's close or storage reset logs, and the close's own summary: the
 *  recovery the rpc-stub pagers re-dial through. They count only when that recovery did not hold: a
 *  pager gave up in the window, or none re-dialed (a reset with no pager on it). So do a reading's
 *  `closeResets`. A visitor 5xx in their rays counts whatever the pagers did. */
const RECOVERED_BY_REDIAL = [
  /^Connection closed: this Durable Object instance is no longer active/u,
  /^close$/u,
  /^Internal error in Durable Object storage caused object to be reset/u,
];

/** What an alarm invocation's summary says: the Date it was scheduled for, as JavaScript prints it. */
const ALARM_SUMMARY =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \(.*\)$/u;

/** The window's incidents: one per cause, visitor 5xx host, healed name or error message. Heals
 *  count only in a burst (10 or more in the window). Pure. */
export function incidentsOf(reading: FaultReading) {
  const incidents = new Map<string, Sighting>();
  const add = (sighting: Sighting) => {
    const key = `${sighting.what}: ${sighting.label}`;
    const before = incidents.get(key);
    incidents.set(key, {
      ...sighting,
      count: (before?.count ?? 0) + sighting.count,
      hosts: mergeCounts(before?.hosts || {}, sighting.hosts),
    });
  };
  const host = (url: string) => url.replace(/^https?:\/\/([^/]+).*$/u, "$1");
  for (const { cause, worker, serverErrors } of reading.causes)
    for (const [url, count] of serverErrors)
      add({ what: cause, label: worker, count, hosts: { [host(url)]: count } });
  // prd answers no 5xx on purpose
  for (const [url, count] of reading.serverErrors)
    add({ what: "visitor 5xx", label: host(url), count, hosts: {} });
  if (reading.heals.reduce((sum, [, n]) => sum + n, 0) >= BURST)
    for (const [name, count] of reading.heals)
      add({ what: "platform-failure heals", label: name, count, hosts: {} });
  const pagers = Object.fromEntries(reading.pagers);
  // a pager's drop is logged with its outcome (apps/os context/rpc-stub-relay.ts `redialPager`)
  const recovered =
    (pagers["rpc-stub-pager-redialed"] ?? 0) > 0 && (pagers[PAGER_GAVE_UP] ?? 0) === 0;
  // An error is keyed by what it says, not by the ids and places in it. A failed invocation's
  // summary is its request line: one incident per method and host, not per path — a scanner's
  // paths (2026-09-24: ~4,300 across 17 project hosts) would otherwise each open an incident. An
  // alarm's summary is the time it was scheduled for: one incident for all. A stack's frames move
  // with every deploy, and an id (a reference, an event, a project) is new with every error.
  for (const [message, count] of [...reading.errors, ...(recovered ? [] : reading.closeResets)]) {
    if (recovered && RECOVERED_BY_REDIAL.some((pattern) => pattern.test(message))) continue;
    const requestLine = /^([A-Z]+ https?:\/\/[^/?#\s]+)\S*$/u.exec(message);
    const label = requestLine
      ? `${requestLine[1]}/…`
      : message
          .replace(ALARM_SUMMARY, "a Durable Object alarm failed")
          .replace(/(?<=\S)\s{2,}at\s.*$/su, "")
          .replace(/[\w-]*\d[\w-]*/gu, (token) => (token.length >= 8 ? "…" : token))
          .slice(0, 80);
    add({ what: "errors", label, count, hosts: {} });
  }
  return incidents;
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>) {
  const merged = { ...a };
  for (const [key, n] of Object.entries(b)) merged[key] = (merged[key] ?? 0) + n;
  return merged;
}

/** One existing page's owed changes: its new text (null when unchanged) and a thread reply. */
type PageUpdate = {
  ts: string;
  text: string | null;
  reply: { text: string; broadcast: boolean } | null;
};

/**
 * What a window owes Slack. Each incident it sees that is open on a page counts there: the page is
 * edited with the running count, and its thread hears of a change of state — grown tenfold since
 * the channel last heard, or back in a burst after an hour's quiet (at most every six hours) —
 * broadcast to the channel. An incident unseen for a day closes; a page whose incidents all closed
 * is `resolved` (slack.ts resolvePage) and leaves the state. The incidents with no open page open
 * one new page. `pages` is the next state's open pages, the new one to be added once posted. Pure.
 */
export function triageIncidents(
  reading: FaultReading,
  window: LogWindow,
  state: AlarmState | null,
  testRun: boolean,
) {
  const now = window.to.getTime();
  const pages = structuredClone(state?.pages || []);
  for (const page of pages)
    for (const incident of Object.values(page.incidents))
      if (now - Date.parse(incident.lastSeen) >= CLOSE_AFTER_MS) incident.closed = true;
  const opened: Record<string, Incident> = {};
  const replies = new Map<string, string[]>();
  for (const [key, sighting] of incidentsOf(reading)) {
    const page = pages.find((open) => open.incidents[key]?.closed === false);
    if (!page) {
      opened[key] = {
        ...sighting,
        told: sighting.count,
        firstSeen: window.to.toISOString(),
        lastSeen: window.to.toISOString(),
        back: null,
        closed: false,
      };
      continue;
    }
    const incident = page.incidents[key]!;
    const quietSince = incident.lastSeen;
    const quiet = window.from.getTime() - Date.parse(quietSince) >= QUIET_AFTER_MS;
    Object.assign(incident, {
      count: incident.count + sighting.count,
      lastSeen: window.to.toISOString(),
      hosts: mergeCounts(incident.hosts, sighting.hosts),
    });
    const lines = replies.get(page.ts) ?? [];
    if (incident.count >= 10 * incident.told) {
      lines.push(`• grew tenfold: ${describe(incident)}`);
      incident.told = incident.count;
    } else if (
      quiet &&
      sighting.count >= BURST &&
      (!incident.back || now - Date.parse(incident.back) >= BACK_EVERY_MS)
    ) {
      lines.push(`• back after quiet since ${stamp(quietSince, now)}: ${describe(sighting)}`);
      incident.told = incident.count;
      incident.back = window.to.toISOString();
    }
    if (lines.length) replies.set(page.ts, lines);
  }
  const updates: PageUpdate[] = [];
  const resolved: { ts: string; text: string; why: string }[] = [];
  const open: Page[] = [];
  for (const page of pages) {
    const incidents = Object.values(page.incidents);
    const text = renderFaultPage(page.incidents, now, testRun);
    if (incidents.every((incident) => incident.closed)) {
      const lastSeen = incidents
        .map((incident) => incident.lastSeen)
        .sort()
        .at(-1)!;
      resolved.push({
        ts: page.ts,
        text,
        why: `no sighting for a day, quiet since ${stamp(lastSeen, now)}`,
      });
      continue;
    }
    const lines = replies.get(page.ts);
    updates.push({
      ts: page.ts,
      text: text === page.text ? null : text,
      reply: lines
        ? {
            text: [
              escalationText(
                `prd fault escalated, ${window.from.toISOString().slice(11, 16)}–${window.to.toISOString().slice(11, 16)} UTC`,
                testRun,
              ),
              ...lines,
            ].join("\n"),
            broadcast: true,
          }
        : null,
    });
    open.push({ ...page, text });
  }
  const page = Object.keys(opened).length
    ? { text: renderFaultPage(opened, now, testRun), incidents: opened }
    : null;
  return {
    page,
    updates: updates.filter((update) => update.text || update.reply),
    resolved,
    pages: open,
  };
}

/** An incident in words: `<what>: <label> <count>`, a cause's with its visitor 5xx by host, at most
 *  five hosts. Pure. */
function describe(incident: Pick<Incident, "what" | "label" | "count" | "hosts">) {
  const label = slackEscape(incident.label);
  const hosts = Object.entries(incident.hosts).sort(([, a], [, b]) => b - a);
  if (!hosts.length) return `${incident.what}: ${label} ${incident.count}`;
  const named = hosts.slice(0, 5).map(([host, n]) => `${slackEscape(host)} ${n}`);
  const more = hosts.length > 5 ? ` +${hosts.length - 5}` : "";
  return `${incident.what} (${label}): ${incident.count} visitor 5xx on ${named.join(", ")}${more}`;
}

/** At most this many incidents are listed on a page, biggest first. */
const PAGE_BULLETS = 8;

/** The page of `incidents`, as it reads at `now`. Its first line names the causes and totals; each
 *  incident is a bullet with its running count and when it was last seen, ✅ once closed. Pure. */
function renderFaultPage(incidents: Record<string, Incident>, now: number, testRun: boolean) {
  const all = Object.values(incidents).sort((a, b) => b.count - a.count);
  const total = (whats: string[]) =>
    all.filter((incident) => whats.includes(incident.what)).reduce((sum, i) => sum + i.count, 0);
  const causes = all.filter((incident) => incident.what in CAUSES);
  const totals = [
    [total(["visitor 5xx", ...CAUSE_NAMES]), "visitor 5xx"],
    [total(["errors"]), "errors"],
    [total(["platform-failure heals"]), "platform-failure heals"],
  ] as const;
  const what = [
    ...new Set(causes.map((cause) => `${cause.what} (${slackEscape(cause.label)})`)),
    ...totals.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}`),
  ].join(", ");
  const firstSeen = all.map((incident) => incident.firstSeen).sort()[0]!;
  const bullets = all.slice(0, PAGE_BULLETS).map((incident) => {
    const seen =
      now - Date.parse(incident.lastSeen) >= QUIET_AFTER_MS
        ? `quiet since ${stamp(incident.lastSeen, now)}`
        : `last ${stamp(incident.lastSeen, now)}`;
    return `• ${incident.closed ? "✅ " : ""}${describe(incident)} · ${seen}`;
  });
  const more = all.length > PAGE_BULLETS ? [`• +${all.length - PAGE_BULLETS} more`] : [];
  return pageText({
    what: `prd: ${what}`,
    impact: [`since ${stamp(firstSeen, now)}`, ...bullets, ...more].join("\n"),
    action: `open <https://dash.cloudflare.com/${PRD_ACCOUNT_ID}/workers-and-pages/observability|Workers Logs> for these rays; /debug-os-worker`,
    link: null,
    testRun,
  });
}

/** `HH:MM UTC`, with the date when `at` is another UTC day than `now`. Pure. */
function stamp(at: string, now: number) {
  const iso = new Date(at).toISOString();
  const day = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return `${day ? "" : `${iso.slice(5, 10)} `}${iso.slice(11, 16)} UTC`;
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

/** The one service selector every Workers Logs query starts with. */
export function workersFilter(workerNames: readonly string[]): LogFilter {
  if (workerNames.length === 0) throw new Error("Workers Logs needs at least one worker name");
  return {
    key: "$metadata.service",
    operation: "in",
    value: workerNames.join(","),
    type: "string",
  };
}

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
 *  (filters every other row passes) rejects; a `keep` of null rejects them all. `name` names it in
 *  the logs. */
export type Exclusion = {
  name: string;
  key: string;
  values: string[];
  keep: LogFilter[] | null;
};

/**
 * The queries counting `base`'s rows except `exclusions`' rows: disjoint filter lists whose counts
 * add up, each within MAX_FILTER_NODES however many exclusions and values there are. Per key, one
 * part holds the rows whose key is null or none of the values, and one part per chunk of values
 * excluded by the same exclusions holds those rows under just those exclusions' `keep` (none at all
 * when one of them keeps nothing); with two keys, each part of one pairs with each part of the
 * other. Row for row, that is the one query ANDing each exclusion's
 * `or(key is_null, key not_in values, keep)`. A part still past MAX_FILTER_NODES is sent without
 * its last keeps, named in `dropped`: its expected rows may page, and a fault never hides. Pure.
 */
export function exclusionQueries(
  base: LogFilter[],
  exclusions: Exclusion[],
  leadingFilter: LogFilter = prdWorkers,
) {
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
      ...[...alike.values()]
        .filter(({ keeps }) => keeps.every((exclusion) => exclusion.keep))
        .flatMap(({ keeps, values }) =>
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
    const query = () => [...base, ...filters, ...kept.flatMap((exclusion) => exclusion.keep || [])];
    // The caller's query leads every query with `leadingFilter`.
    while (kept.length && filterNodes([leadingFilter, ...query()]) > MAX_FILTER_NODES)
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

/** What an error row is, for the counts: a line an invocation logged (an exception or a
 *  console.error), a request line (a fetch invocation's summary) or another summary. */
type ErrorRows = "lines" | "requestLines" | "summaries";

const leaf = (
  key: string,
  operation: string,
  value?: string | number,
  type: "string" | "number" = "string",
): LogFilter => (value === undefined ? { key, operation, type } : { key, operation, value, type });
const anyOf = (...filters: LogFilter[]): LogFilter => ({
  kind: "group",
  filterCombination: "or",
  filters,
});

/** The visitor's own invocation: the stateless one of the first-party Worker a request reached,
 *  with no named entrypoint. A Durable Object's, an ItxEntrypoint's (a project's globalOutbound, so
 *  also every third party's answer relayed through it) and a service binding's hops are not it. */
const VISITOR: LogFilter[] = [
  leaf("$workers.executionModel", "eq", "stateless"),
  leaf("$workers.entrypoint", "is_null"),
];
const SERVER_ERROR = leaf("$workers.event.response.status", "gte", 500, "number");
const NETWORK_LOST = "Network connection lost.";

/** Each kind of error row as a count selects it. A request line counts only on the visitor's own
 *  invocation and only without a 5xx, which serverErrors counts: what a visitor saw, once. */
const ERROR_ROWS: Record<ErrorRows, LogFilter[]> = {
  lines: [
    anyOf(leaf("$metadata.type", "is_null"), leaf("$metadata.type", "neq", "cf-worker-event")),
  ],
  requestLines: [
    leaf("$metadata.type", "eq", "cf-worker-event"),
    leaf("$workers.eventType", "eq", "fetch"),
    ...VISITOR,
    anyOf(
      leaf("$workers.event.response.status", "is_null", undefined, "number"),
      leaf("$workers.event.response.status", "lt", 500, "number"),
    ),
  ],
  summaries: [
    leaf("$metadata.type", "eq", "cf-worker-event"),
    anyOf(leaf("$workers.eventType", "is_null"), leaf("$workers.eventType", "neq", "fetch")),
  ],
};

/**
 * Expected outcomes dropped by their ray: in the rays of `evidence`'s rows, the rows of each count
 * named in `keep` that its filters reject (null: every row). Counts not named are untouched.
 *
 * Two expression-fetch answers are 5xx on purpose, each logged at info by the context DO that
 * answered (apps/os iterate-context-durable-object.ts): a fetch route whose target is an offline
 * lent stub (`iterate tunnel` killed without Ctrl-C) answers 502, the upstream's absence, logged
 * `expression-fetch.rpc-stub-offline`, and a Vite tab left open re-requests it every second; a
 * deploy that reset a context the fetch dialed, when the hop could not send it again (a request
 * with a body), answers 503, logged `expression-fetch.deploy-reset`. The visitor's invocation
 * answers the same status, under its own requestId: the loaded config worker starts a new traceId,
 * so only the edge's rayId joins it to the info line. `keep` rejects only a 5xx of the answer's
 * status: another status or another ray still pages.
 *
 * A visitor whose connection went away mid-response (a WebSocket's laptop asleep, a tab closed):
 * the runtime fails the visitor's own invocation with "Network connection lost." and an exception
 * summary with no status, since the visitor was sent nothing more. Those two go; a 5xx or any other
 * error in the ray still pages.
 */
type RayOutcome = {
  name: string;
  evidence: LogFilter[];
  keep: Partial<Record<"serverErrors" | ErrorRows, LogFilter[] | null>>;
};
const RAY_OUTCOMES: RayOutcome[] = [
  ...[
    { event: "expression-fetch.rpc-stub-offline", status: 502 },
    { event: "expression-fetch.deploy-reset", status: 503 },
  ].map(({ event, status }): RayOutcome => ({
    name: event,
    evidence: [leaf("event", "eq", event)],
    keep: {
      serverErrors: [
        anyOf(
          leaf("$metadata.type", "is_null"),
          leaf("$metadata.type", "neq", "cf-worker-event"),
          leaf("$workers.event.response.status", "is_null", undefined, "number"),
          leaf("$workers.event.response.status", "neq", status, "number"),
        ),
      ],
    },
  })),
  {
    name: "visitor-gone",
    evidence: [leaf("$metadata.message", "eq", NETWORK_LOST), ...VISITOR],
    keep: {
      lines: [
        anyOf(leaf("$metadata.message", "is_null"), leaf("$metadata.message", "neq", NETWORK_LOST)),
      ],
      requestLines: [
        anyOf(leaf("$workers.outcome", "is_null"), leaf("$workers.outcome", "neq", "exception")),
      ],
    },
  },
];

/**
 * Faults a deploy causes, each its own incident per Worker: a Durable Object reset because its code
 * was updated, and the version skew of a message cloned between the old and new version. Every row
 * in their rays is the cause's: the errors are its expected outcome and never page, and the visitor
 * 5xx page as the Worker's deploys' (CauseReading), never as their hosts'. A ray with no visitor 5xx
 * pages nothing. The one error that still pages there is PAGER_GAVE_UP: the recovery a deploy's
 * reset is meant to go through failed.
 */
const CAUSE_NAMES = ["deploy reset", "version skew"] as const;
/** An rpc-stub pager that could not re-dial within its bound (apps/os context/rpc-stub-relay.ts
 *  `redialPager`): the /api session's pager, in the ray of the deploy that reset its Durable
 *  Object. The bound exists so that a deploy's reset does not page; past it, the give-up does. */
const PAGER_GAVE_UP = "rpc-stub-pager-redial-failed";
type Cause = (typeof CAUSE_NAMES)[number];
const CAUSES: Record<Cause, string> = {
  "deploy reset": "Durable Object reset because its code was updated",
  "version skew": "Unable to deserialize cloned data due to invalid or unsupported version",
};

/** Error messages that are expected outcomes wherever they are logged: a deploy's own, which the
 *  runtime logs (its visitor 5xx page as the deploy's). An expected outcome of the platform's own
 *  is announced by it instead (ANNOUNCED). */
const EXPECTED_ERRORS = Object.values(CAUSES);

/**
 * Outcomes the platform expects and announces at info, each with the message of the error line the
 * runtime logs for it itself, uncatchably: a reset the context DO asks for (`ctx.abort`: a destroyed
 * context, `itx.abort()`, a deleted root whose project came back), which the runtime logs in the
 * asking invocation and in every other call in flight that it rejects, and the constructor's refusal
 * of an id nothing was born at, the context sweep's lookup of an object emptied moments ago (apps/os
 * iterate-context-durable-object.ts `#abort`, `iterateContextAddressOf`). And a facet deleted with
 * its hosting row, whose cut-off call session the runtime logs as a bare `<class>.jsrpc` summary
 * (apps/os context/facet-host.ts `#deleteFacet`). An error line whose message a Durable Object
 * announced in the window, in that Durable Object, is that outcome and pages nothing, and its
 * invocation's summary folds into it; so does a summary with no line that the Durable Object
 * announced (folded-summaries). The same error in a Durable Object that announced nothing pages.
 */
const ANNOUNCED = [
  "context.destroyed",
  "context.aborted",
  "context.root-restored",
  "context.unborn-by-id",
  "facet.deleted",
];

const UNREAD_BODY = "Can't read from request stream after response has been sent";
const FALSE_HUNG =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response";
const RPC_BODY_ENDED_EARLY = "ReadableStream received over RPC disconnected prematurely";

/** Logged anywhere but on the `entrypoint` invocations, a stateless worker's own included. */
const notOn = (entrypoint: string) =>
  anyOf(leaf("$workers.entrypoint", "is_null"), leaf("$workers.entrypoint", "neq", entrypoint));

/**
 * CLOUDFLARE DEFECTS THAT ONLY LOG A LINE: the runtime logs an error where no call failed. Each is
 * pinned (`pin`: the test that goes red once Cloudflare fixes it, or the upstream issue), and an
 * error line with its `message` pages only where `pages` selects it: anywhere else it is the defect.
 * Delete an entry when its pin goes red.
 */
const PINNED_LINES: { message: string; pin: string; pages: LogFilter[] }[] = [
  {
    // A Durable Object that answers before a request body is read, though the client got its
    // response. Scanners POSTing to project hosts raise it on ~3 % of chunked bodies even with the
    // itx-expression fetch's pipe. It pages only on `/api` itself — the capnweb endpoint, a
    // platform call, not a site visit (`/api/…` is a site's path).
    message: UNREAD_BODY,
    pin: "https://github.com/cloudflare/workerd/issues/918",
    pages: [
      anyOf(
        leaf("$metadata.message", "includes", UNREAD_BODY),
        leaf("$metadata.error", "includes", UNREAD_BODY),
      ),
      leaf("$workers.event.request.url", "regex", "^https?://[^/]+/api(\\?|$)"),
    ],
  },
  {
    // The runtime's own line: always a message. The fault is its pin's.
    message: FALSE_HUNG,
    pin: "apps/agents/e2e/ai-stream-hung-request.e2e.test.ts",
    pages: [leaf("$metadata.message", "includes", FALSE_HUNG), notOn("ItxEntrypoint")],
  },
  {
    // The runtime's own line: always a message. The fault is its pin's.
    message: RPC_BODY_ENDED_EARLY,
    pin: "apps/os/src/context/forwarded-rpc-body.test.ts",
    pages: [
      leaf("$metadata.message", "includes", RPC_BODY_ENDED_EARLY),
      notOn("IterateContextDurableObject"),
    ],
  },
];

/** The error line the runtime logs in a context's hibernatable WebSocket close event when the
 *  object was reset under the socket: its opaque "internal error; reference = …", before any of our
 *  code runs (workerd api/hibernatable-web-socket.c++). It is the drop of the socket an rpc-stub
 *  pager holds: FaultReading `closeResets`, recovered as RECOVERED_BY_REDIAL's are. */
const CLOSE_RESET: LogFilter[] = [
  leaf("$metadata.message", "includes", "internal error; reference = "),
  leaf("$workers.eventType", "eq", "hibernatableWebSocket"),
  leaf("$workers.event.webSocketType", "eq", "close"),
  leaf("$workers.entrypoint", "eq", "IterateContextDurableObject"),
];

/** Whether an error row with `message` is an expected outcome (EXPECTED_ERRORS, or a pinned line,
 *  whose own count reads where it pages). Pure. */
function expectedError(message: string) {
  return [...EXPECTED_ERRORS, ...PINNED_LINES.map((pinned) => pinned.message)].some((expected) =>
    message.includes(expected),
  );
}

/** Reads one bounded Workers Logs window for the named workers without writing or posting. */
export async function readWorkersFaultWindow(
  window: LogWindow,
  { accountId, apiToken }: CloudflareCredentials,
  workerNames: readonly string[] = PRD_WORKERS,
): Promise<FaultReading> {
  const leadingFilter = workersFilter(workerNames);
  // One grouped count per signal: one query, or with exclusions several over disjoint rows
  // (exclusionQueries). Its rows sum to a lower bound (events without the grouped field, or past
  // 2,000 groups in a query, drop out) — a burst still pages.
  //
  // A query only reads, so one that Cloudflare itself failed (a 5xx, a 429, an answer that is not
  // JSON — its HTML error page, whatever the status — or a dropped connection) is asked again after
  // each of CI_HTTP's waits, with a `prd-fault-alarm.platform-failure-retry` warn per repeat; the last
  // failure fails the run. Any other JSON answer is Cloudflare's answer about the query: a broken
  // token (success: false) or a renamed field fails the run at once, never reads as a quiet prd.
  const query = (filters: LogFilter[], parameters: object) =>
    retryPlatformFailures(
      async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
          {
            method: "POST",
            signal: AbortSignal.timeout(30_000), // one bounded read
            headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
            body: JSON.stringify({
              queryId: "prd-fault-alarm",
              view: "calculations",
              timeframe: { from: window.from.getTime(), to: window.to.getTime() },
              parameters: {
                datasets: ["cloudflare-workers"],
                ...parameters,
                filters: [leadingFilter, ...filters],
              },
            }),
          },
        );
        const text = await response.text();
        // The message names the status, the content type and the answer's first 200 bytes.
        const failed = new HttpAnswerError(
          `Workers Logs query answered HTTP ${response.status} (${response.headers.get("content-type") ?? "no content-type"}): ${text.slice(0, 200)}`,
          response,
        );
        if (response.status >= 500 || response.status === 429) throw failed;
        let answer: unknown;
        try {
          answer = JSON.parse(text);
        } catch {
          throw failed;
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
        area: "prd-fault-alarm",
        schedule: CI_HTTP,
        idempotent: true,
        // Every HttpAnswerError thrown above is Cloudflare's own failure, the HTML page included.
        kind: (error) =>
          error instanceof HttpAnswerError ? "disconnected" : httpFailureKind(error),
        describe: httpFailureFields,
      },
    );
  // Each row's group values, one per `groupBys` field; a row missing any of them drops out, as
  // Cloudflare drops it. Without `groupBys`, one row: [[], the total].
  const rows = async (filters: LogFilter[], groupBys: string[]): Promise<[string[], number][]> => {
    const result = z
      .object({
        calculations: z
          .array(
            z.object({
              aggregates: z.array(
                z.object({
                  groups: z
                    .array(
                      z.object({
                        value: z
                          .string()
                          .nullish()
                          .transform((value) => value || ""),
                      }),
                    )
                    .default([]),
                  count: z.number(),
                }),
              ),
            }),
          )
          .min(1),
      })
      .parse(
        await query(filters, {
          calculations: [{ operator: "count" }],
          groupBys: groupBys.map((value) => ({ type: "string", value })),
          orderBy: { value: "count", order: "desc" },
          limit: 2000,
        }),
      );
    return result.calculations[0]!.aggregates.map((row) => [
      row.groups.map((group) => group.value),
      row.count,
    ]);
  };
  const count = async (base: LogFilter[], exclusions: Exclusion[], groupBy?: string) => {
    const parts = exclusionQueries(base, exclusions, leadingFilter);
    const counted = new Map<string, number>();
    const found = await Promise.all(
      parts.map(({ filters }) => rows(filters, groupBy ? [groupBy] : [])),
    );
    for (const [index, { dropped }] of parts.entries()) {
      const partRows = found[index]!;
      for (const [[key = ""], n] of partRows) counted.set(key, (counted.get(key) ?? 0) + n);
      // A part without rows lost nothing to its dropped keeps.
      const total = partRows.reduce((sum, [, n]) => sum + n, 0);
      if (dropped.length && total)
        console.warn(
          JSON.stringify({ event: "prd-fault-alarm.exclusion-dropped", dropped, rows: total }),
        );
    }
    return [...counted].sort(([, a], [, b]) => b - a);
  };
  // A read of evidence that is capped (2,000 groups) or failed excludes nothing: it can only remove
  // noise, never lose an observed fault.
  const evidence = <T>(name: string, read: () => Promise<T[]>) =>
    read().then(
      (found) => (found.length >= 2000 ? [] : found),
      (error: unknown) => {
        console.warn(
          JSON.stringify({
            event: "prd-fault-alarm.exclusion-evidence-failed",
            exclusion: name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return [];
      },
    );
  const errorLevel = leaf("$metadata.level", "eq", "error");
  const [outcomeRays, causeRays, summaryRequests, announcements] = await Promise.all([
    Promise.all(
      RAY_OUTCOMES.map((outcome) =>
        evidence(outcome.name, async () =>
          (await rows(outcome.evidence, ["$metadata.rayId"])).map(([[rayId]]) => rayId!),
        ),
      ),
    ),
    Promise.all(
      CAUSE_NAMES.map((cause) =>
        evidence(cause, () =>
          rows(
            [
              anyOf(
                leaf("$metadata.message", "includes", CAUSES[cause]),
                leaf("$metadata.error", "includes", CAUSES[cause]),
              ),
            ],
            ["$metadata.rayId", "$workers.executionModel", "$metadata.service"],
          ),
        ),
      ),
    ),
    evidence("summaries", async () =>
      (await rows([errorLevel, ...ERROR_ROWS.summaries], ["$metadata.requestId"])).map(
        ([[requestId]]) => requestId!,
      ),
    ),
    evidence("announced", () =>
      rows(
        [leaf("event", "in", ANNOUNCED.join(","))],
        ["$workers.durableObjectId", "$metadata.message"],
      ),
    ),
  ]);
  // Each Durable Object that announced an outcome (ANNOUNCED), with the messages it announced.
  const announced = new Map<string, Set<string>>();
  for (const [[objectId, message]] of announcements)
    if (objectId && message) announced.set(objectId, new Set(announced.get(objectId)).add(message));
  // Summaries folded away, by request ID. The summary of an invocation that also logged its exception
  // (a `*.jsrpc` call's, an alarm's) is that exception's sighting, counted (or expected) once, as the
  // exception. A summary with no line whose message its Durable Object announced (ANNOUNCED: the
  // call session a facet's deletion cut off) is that announced outcome.
  const [summarizedExceptions, announcedSummaries] = await Promise.all([
    evidence("summarized-exceptions", async () => {
      const found = await Promise.all(
        chunks(summaryRequests).map((chunk) =>
          rows(
            [errorLevel, ...ERROR_ROWS.lines, leaf("$metadata.requestId", "in", chunk.join(","))],
            ["$metadata.requestId"],
          ),
        ),
      );
      return found.flat().map(([[requestId]]) => requestId!);
    }),
    evidence("announced-summaries", async () => {
      const found = await Promise.all(
        chunks([...announced.keys()]).map((objectIds) =>
          rows(
            [
              errorLevel,
              ...ERROR_ROWS.summaries,
              leaf("$workers.durableObjectId", "in", objectIds.join(",")),
            ],
            ["$metadata.requestId", "$workers.durableObjectId", "$metadata.message"],
          ),
        ),
      );
      return found
        .flat()
        .filter(([[, objectId = "", message = ""]]) => announced.get(objectId)?.has(message))
        .map(([[requestId]]) => requestId!);
    }),
  ]);
  // The summaries count's filters leave room for one `not_in` of request IDs: past 500 folded
  // summaries, the rest page, and the log says how many.
  const folded = [...new Set([...summarizedExceptions, ...announcedSummaries])];
  if (folded.length > 500)
    console.warn(
      JSON.stringify({ event: "prd-fault-alarm.fold-capped", unfolded: folded.length - 500 }),
    );
  const foldedSummaries = folded.slice(0, 500);
  // The rays of every outcome and cause, together, stay under 2,000: the most a count's four `not_in`
  // of rays can hold beside its own filters. Evidence past that excludes nothing.
  let excludedRays = 0;
  const kept = (name: string, rays: string[]) => {
    const capped = excludedRays + rays.length >= 2000;
    console.log(
      JSON.stringify({
        event: "prd-fault-alarm.exclusion-evidence",
        exclusion: name,
        rays: rays.length,
        capped,
      }),
    );
    if (capped) return [];
    excludedRays += rays.length;
    return rays;
  };
  const outcomes = RAY_OUTCOMES.map((outcome, index) => ({
    ...outcome,
    rays: kept(outcome.name, outcomeRays[index]!),
  }));
  // A ray with an expected 5xx answer is that answer's, not a cause's: its status is by design.
  const answered = new Set(
    outcomes.filter((outcome) => outcome.keep.serverErrors).flatMap((outcome) => outcome.rays),
  );
  const caused = new Set<string>();
  const deploys = CAUSE_NAMES.flatMap((cause, index) => {
    // A ray whose cause both a Durable Object and its caller logged is the Durable Object's deploy.
    const found = causeRays[index]!.toSorted(
      ([a], [b]) => Number(b[1] === "durableObject") - Number(a[1] === "durableObject"),
    );
    const byRay = new Map<string, string>();
    for (const [[rayId, , service]] of found)
      if (rayId && service && !answered.has(rayId) && !caused.has(rayId) && !byRay.has(rayId))
        byRay.set(rayId, service);
    // A ray is one cause's, the first that names it: its 5xx page once.
    for (const rayId of byRay.keys()) caused.add(rayId);
    const rays = new Set(kept(cause, [...byRay.keys()]));
    const byWorker = new Map<string, string[]>();
    for (const [rayId, worker] of byRay)
      if (rays.has(rayId)) byWorker.set(worker, [...(byWorker.get(worker) ?? []), rayId]);
    return [...byWorker].map(([worker, workerRays]) => ({ cause, worker, rays: workerRays }));
  });
  const exclusionsFor = (rowsOf: "serverErrors" | ErrorRows): Exclusion[] => [
    ...outcomes
      .filter((outcome) => rowsOf in outcome.keep)
      .map((outcome) => ({
        name: outcome.name,
        key: "$metadata.rayId",
        values: outcome.rays,
        keep: outcome.keep[rowsOf]!,
      })),
    {
      name: "deploy-causes",
      key: "$metadata.rayId",
      values: deploys.flatMap((deploy) => deploy.rays),
      keep: rowsOf === "lines" ? [leaf("event", "eq", PAGER_GAVE_UP)] : null,
    },
    ...(rowsOf === "summaries"
      ? [
          {
            name: "folded-summaries",
            key: "$metadata.requestId",
            values: foldedSummaries,
            keep: null,
          },
        ]
      : []),
  ];
  // Every visitor 5xx pages, so they are counted twice: by URL, and in all. The ones the URL rows
  // miss (no URL logged, or past 2,000 groups) page as `unknown`.
  const serverErrorRows = [SERVER_ERROR, ...VISITOR];
  const readServerErrors = async () => {
    const [byUrl, all] = await Promise.all([
      count(serverErrorRows, exclusionsFor("serverErrors"), "$workers.event.request.url"),
      count(serverErrorRows, exclusionsFor("serverErrors")),
    ]);
    const missed = (all[0]?.[1] ?? 0) - byUrl.reduce((sum, [, n]) => sum + n, 0);
    return missed > 0 ? [...byUrl, ["unknown", missed] satisfies [string, number]] : byUrl;
  };
  const readCauses = () =>
    Promise.all(
      deploys.map(async ({ cause, worker, rays }) => {
        const found = await Promise.all(
          chunks(rays).map((chunk) =>
            count(
              [...serverErrorRows, leaf("$metadata.rayId", "in", chunk.join(","))],
              [],
              "$workers.event.request.url",
            ),
          ),
        );
        const serverErrors = [
          ...found
            .flat()
            .reduce(
              (sum, [url, n]) => sum.set(url, (sum.get(url) ?? 0) + n),
              new Map<string, number>(),
            ),
        ];
        return { cause, worker, serverErrors };
      }),
    ).then((causes) => causes.filter((cause) => cause.serverErrors.length));
  // A count of error rows of `rowsOf` by `key`. reportIssue logs an error object without a message,
  // which Cloudflare puts in $metadata.error: the lines are read by message, and by error where the
  // message is absent or empty, with the same policy.
  const readErrors = (
    rowsOf: ErrorRows,
    key: "$metadata.message" | "$metadata.error",
    filters: LogFilter[],
  ) => count([errorLevel, ...ERROR_ROWS[rowsOf], ...filters], exclusionsFor(rowsOf), key);
  // The message lines of the announcing Durable Objects that carry a message they announced, by
  // message: rows the message lines' count reads, under its filters and exclusions, known expected.
  // An announced outcome's line always has its message: the error lines without one are none.
  const lineFilters = [leaf("$metadata.message", "neq", "")];
  const readAnnounced = async () => {
    const found = await Promise.all(
      chunks([...announced.keys()]).flatMap((objectIds) =>
        exclusionQueries(
          [
            errorLevel,
            ...ERROR_ROWS.lines,
            ...lineFilters,
            leaf("$workers.durableObjectId", "in", objectIds.join(",")),
          ],
          exclusionsFor("lines"),
        ).map(({ filters }) => rows(filters, ["$workers.durableObjectId", "$metadata.message"])),
      ),
    );
    const expected = new Map<string, number>();
    for (const [[objectId = "", message = ""], n] of found.flat())
      if (announced.get(objectId)?.has(message))
        expected.set(message, (expected.get(message) ?? 0) + n);
    return expected;
  };
  // Each pinned line where it still pages, under its message (PINNED_LINES).
  const readPinnedLinesElsewhere = async () =>
    (
      await Promise.all(
        PINNED_LINES.map(async ({ message, pages }) => {
          const [[, n] = ["", 0]] = await count(
            [errorLevel, ...ERROR_ROWS.lines, ...pages],
            exclusionsFor("lines"),
          );
          return n ? [[`${message}.`, n] satisfies [string, number]] : [];
        }),
      )
    ).flat();
  const healed = [leaf("event", "includes", "platform-failure")];
  const [
    serverErrors,
    causes,
    heals,
    healEvents,
    lines,
    announcedLines,
    closeResets,
    structured,
    pinnedLinesElsewhere,
    requestLines,
    summaries,
    pagers,
  ] = await Promise.all([
    readServerErrors(),
    readCauses(),
    rows(healed, ["name"]),
    rows(healed, ["event"]),
    readErrors("lines", "$metadata.message", lineFilters),
    readAnnounced(),
    readErrors("lines", "$metadata.message", CLOSE_RESET),
    readErrors("lines", "$metadata.error", [
      leaf("$metadata.error", "neq", ""),
      anyOf(leaf("$metadata.message", "is_null"), leaf("$metadata.message", "eq", "")),
    ]),
    readPinnedLinesElsewhere(),
    readErrors("requestLines", "$metadata.message", []),
    readErrors("summaries", "$metadata.message", []),
    rows([leaf("event", "includes", "rpc-stub-pager-")], ["event"]),
  ]);
  const single = (found: [string[], number][]) =>
    found.map(([[key = ""], n]): [string, number] => [key, n]);
  // The close resets are lines the message lines' count read too: counted apart, as closeResets.
  const closed = new Map(closeResets);
  return {
    serverErrors,
    causes,
    heals: single(heals),
    healEvents: single(healEvents),
    errors: [
      ...[
        ...lines.map(([message, n]): [string, number] => [
          message,
          n - (announcedLines.get(message) ?? 0) - (closed.get(message) ?? 0),
        ]),
        ...structured,
      ].filter(([message, n]) => n > 0 && !expectedError(message)),
      ...pinnedLinesElsewhere,
      ...requestLines,
      ...summaries,
    ],
    closeResets,
    pagers: single(pagers),
  };
}

/** The newest main run's state, written to `out`; nothing when no run of the last 20 kept one. */
export async function previousState(options: { out: string }) {
  return saveNewestArtifactFile(depotApi(), {
    ...stateArtifact,
    out: options.out,
  });
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-fault-alarm" }).run();
