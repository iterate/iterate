// scripts/preview-residency.ts — the pure half of the preview's RESIDENCY GATE (scripts/preview.ts
// `residency` runs it after the e2e suite; preview-residency.test.ts pins it). It asks one question
// and knows nothing about why the answer could be yes: after the suite has ended and every client is
// closed, is any Durable Object of this preview still resident — billed, with nobody connected?
// Every pin fixed so far was proven by a row written around the mechanism its author suspected; the
// suite stayed green while previews left 1,000–3,000 objects resident until the next push (09-21/22,
// >$1000/day on the dev/preview account). This reads the bill's own meter instead: Cloudflare's GraphQL
// `durableObjectsPeriodicGroups`, one row per object per minute with its `activeTime`.
//
// The rules:
//   1. The preview's objects are the objects in its own namespaces: a Worker Preview provisions a
//      namespace per class, and the namespace listing names the preview (`preview.name`) and the
//      parent worker (`script`). Uuid-named projects (`prj_<32 hex>`) are covered as well as the
//      run-id-named ones, and nothing of another preview is.
//   2. The window is five whole minutes, starting five minutes after the suite ended (the end rounded
//      up to the minute): an idle object is evicted about 10 s after its last call, and the longest
//      legitimate tail measured is a root context's ~2 min after `repos.create`.
//   3. An object's resident seconds are its window minutes' `activeTime`, each capped at 60 s: the
//      meter sums an object's instances, so a context with a live facet reports 120 s a minute.
//   4. Resident means 240 s or more: 80 % of the window.
//   5. A resident object whose name an entry of RESIDENT_BY_DESIGN matches is listed with that entry's
//      reason and passes; every other resident object fails the gate.
//   6. A run that touched more than MAX_DURABLE_OBJECTS_PER_RUN distinct objects fails the gate.
//   7. An answer at the query's row limit fails the gate: a truncated answer cannot prove absence.
//   8. An answer that shows no object touched during the suite fails the gate: a gate that cannot see
//      the run (a wrong namespace, a broken token, analytics down) proves nothing.
import { z } from "zod";

/** Rule 6. A normal run touches ~510–550 distinct objects (measured 2026-09-22/23: pr2837 ~510 a
 *  run, pr2828 ~550, pr2847 507); four times that is growth, not a load test — the #2828 burst of
 *  25,604 objects belongs in a dispatch-only workflow, not on every push. */
export const MAX_DURABLE_OBJECTS_PER_RUN = 2000;

/** GraphQL's own ceiling for one list (`limit`), rule 7. */
export const DURABLE_OBJECT_ANALYTICS_ROW_LIMIT = 10_000;

/** Rule 5: objects resident by design, by name. Every entry says what keeps the object resident
 *  with no client connected, and which run's data showed it. An entry is a decision, not a silencer:
 *  a pattern broad enough to hide a class of leak is a bug in this list. */
export const RESIDENT_BY_DESIGN: { namePattern: RegExp; reason: string }[] = [
  // Deliberate test subjects for one known platform gap, each the root context of its fixture's
  // project (e2e/support/client.ts `freshCtx`: `prj_<prefix>_<run>_<worker>_<n>`), resident on
  // PR #2849's run of 2026-09-23 (window 15:05–15:10Z). Any other path of these projects still fails.
  ...[
    "live", // e2e/live-state-chains-client-side.e2e.test.ts: the chatroom facet
    "residency_careless_data", // e2e/context-residency.e2e.test.ts
    "residency_careless_live",
    "residency_careless_sibling",
    "residency_live_state_sink",
    "rest", // e2e/workers-and-facets.e2e.test.ts: a facet stashes a live itx handle
  ].map((prefix) => ({
    namePattern: new RegExp(`^prj_${prefix}_[0-9a-f]{8}_\\d+_\\d+\\.iterate/$`),
    reason:
      "a userspace facet keeps an env.ITX value and outlives its context — the platform gap the facet birth rule closes (facet-outlives-context investigation); remove this entry when that ships",
  })),
];

/** One row of the account's Durable Object namespace listing (`GET /workers/durable_objects/namespaces`). */
export const DurableObjectNamespace = z.object({
  id: z.string(),
  script: z.string().nullish(),
  class: z.string().nullish(),
  preview: z.object({ name: z.string() }).nullish(),
});
export type DurableObjectNamespace = z.infer<typeof DurableObjectNamespace>;

/** Rule 1. */
export function previewDurableObjectNamespaces(
  namespaces: DurableObjectNamespace[],
  input: { parentWorkerName: string; previewName: string },
): DurableObjectNamespace[] {
  return namespaces.filter(
    (namespace) =>
      namespace.script === input.parentWorkerName && namespace.preview?.name === input.previewName,
  );
}

/** Rule 2: `[start, end)`, whole minutes. */
export function durableObjectResidencyWindow(suiteEnded: Date): { start: Date; end: Date } {
  const minute = 60_000;
  const start = Math.ceil(suiteEnded.getTime() / minute) * minute + 5 * minute;
  return { start: new Date(start), end: new Date(start + 5 * minute) };
}

/** One query, three answers: the account's newest analytics minute (is the window's data in yet?),
 *  every window minute of every object in the preview's namespaces, and every object the run touched
 *  (grouped by object alone, one row each). Every filter is also bounded by `$readAt`, the moment of
 *  the read: Cloudflare answers an identical request from a cache for minutes (measured 2026-09-23:
 *  one request returned the same stale rows from 10:38 to 10:46 while a request differing only in a
 *  time bound was current), so a poll that repeated itself would keep reading the past. */
export const DURABLE_OBJECT_RESIDENCY_QUERY = `query DurableObjectResidency($accountTag: string!, $namespaceIds: [string!], $windowStart: Time!, $windowEnd: Time!, $suiteStarted: Time!, $suiteEnded: Time!, $readAt: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      newestMinute: durableObjectsPeriodicGroups(limit: 1, filter: { datetimeMinute_geq: $windowStart, datetime_leq: $readAt }, orderBy: [datetimeMinute_DESC]) {
        dimensions { datetimeMinute }
      }
      windowMinutes: durableObjectsPeriodicGroups(limit: ${DURABLE_OBJECT_ANALYTICS_ROW_LIMIT}, filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $windowStart, datetimeMinute_lt: $windowEnd, datetime_leq: $readAt }) {
        dimensions { datetimeMinute namespaceId objectId name }
        sum { activeTime }
      }
      runObjects: durableObjectsPeriodicGroups(limit: ${DURABLE_OBJECT_ANALYTICS_ROW_LIMIT}, filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $suiteStarted, datetimeMinute_lt: $suiteEnded, datetime_leq: $readAt }) {
        dimensions { objectId }
      }
    }
  }
}`;

export function durableObjectResidencyVariables(input: {
  accountTag: string;
  namespaceIds: string[];
  window: { start: Date; end: Date };
  suite: { started: Date; ended: Date };
  readAt: Date;
}) {
  return {
    accountTag: input.accountTag,
    namespaceIds: input.namespaceIds,
    windowStart: input.window.start.toISOString(),
    windowEnd: input.window.end.toISOString(),
    readAt: input.readAt.toISOString(),
    // the minute the suite started in, through the minute it ended in
    suiteStarted: new Date(
      Math.floor(input.suite.started.getTime() / 60_000) * 60_000,
    ).toISOString(),
    suiteEnded: new Date(Math.ceil(input.suite.ended.getTime() / 60_000) * 60_000).toISOString(),
  };
}

/** The answer to DURABLE_OBJECT_RESIDENCY_QUERY, validated: one account (the filter names one), and
 *  `activeTime` in microseconds. */
export const DurableObjectResidencyAnswer = z.object({
  data: z.object({
    viewer: z.object({
      accounts: z.tuple([
        z.object({
          newestMinute: z.array(z.object({ dimensions: z.object({ datetimeMinute: z.string() }) })),
          windowMinutes: z.array(
            z.object({
              dimensions: z.object({
                datetimeMinute: z.string(),
                namespaceId: z.string(),
                objectId: z.string(),
                name: z.string().nullish(),
              }),
              sum: z.object({ activeTime: z.number() }),
            }),
          ),
          runObjects: z.array(z.object({ dimensions: z.object({ objectId: z.string() }) })),
        }),
      ]),
    }),
  }),
});
export type DurableObjectResidencyAnswer = z.infer<typeof DurableObjectResidencyAnswer>;
type DurableObjectResidencyAccount = DurableObjectResidencyAnswer["data"]["viewer"]["accounts"][0];

/** Is the window's last minute complete? A minute's rows keep landing after it ends: read one minute
 *  after the window, its last minute was missing 10 of 22 resident objects; read two minutes after,
 *  it held all 22 (measured 2026-09-23). So the window counts as read once the account reports the
 *  minute that starts one minute after the window ends. An idle account reports no minute at all,
 *  which is why the caller also stops waiting at a deadline. */
export function durableObjectAnalyticsCoverWindow(
  account: DurableObjectResidencyAccount,
  window: { end: Date },
): boolean {
  const newest = account.newestMinute[0]?.dimensions.datetimeMinute;
  if (!newest) return false;
  return Date.parse(newest) >= window.end.getTime() + 60_000;
}

export type ResidentDurableObject = {
  objectId: string;
  name: string | undefined;
  className: string;
  residentSeconds: number;
  /** RESIDENT_BY_DESIGN's reason, when an entry matches the name. */
  residentByDesign: string | undefined;
};

export type DurableObjectResidencyVerdict = {
  window: { start: Date; end: Date };
  /** Every object resident in the window (rule 4), allowed or not, longest first. */
  residentDurableObjects: ResidentDurableObject[];
  runObjectCount: number;
  /** Why the gate fails; empty when it passes. */
  failures: string[];
};

/** Rules 3–8 over one answer. */
export function durableObjectResidencyVerdict(input: {
  account: DurableObjectResidencyAccount;
  namespaces: DurableObjectNamespace[];
  window: { start: Date; end: Date };
  residentByDesign?: { namePattern: RegExp; reason: string }[];
}): DurableObjectResidencyVerdict {
  const residentByDesign = input.residentByDesign || RESIDENT_BY_DESIGN;
  const classNameByNamespaceId = new Map(
    input.namespaces.map((namespace) => [namespace.id, namespace.class || namespace.id]),
  );
  const objects = new Map<string, ResidentDurableObject>();
  for (const row of input.account.windowMinutes) {
    const { objectId, namespaceId, name } = row.dimensions;
    const object = objects.get(objectId) || {
      objectId,
      name: name || undefined,
      className: classNameByNamespaceId.get(namespaceId) || namespaceId,
      residentSeconds: 0,
      residentByDesign: residentByDesign.find((entry) => name && entry.namePattern.test(name))
        ?.reason,
    };
    object.residentSeconds += Math.min(60, row.sum.activeTime / 1e6);
    objects.set(objectId, object);
  }
  const residentDurableObjects = [...objects.values()]
    .filter((object) => object.residentSeconds >= 240)
    .map((object) => ({ ...object, residentSeconds: Math.round(object.residentSeconds) }))
    .sort(
      (a, b) => b.residentSeconds - a.residentSeconds || (a.name || "").localeCompare(b.name || ""),
    );
  const leaked = residentDurableObjects.filter((object) => !object.residentByDesign);
  const runObjectCount = input.account.runObjects.length;
  const failures = [
    leaked.length > 0 &&
      `${leaked.length} Durable Object${leaked.length === 1 ? "" : "s"} resident for at least 80 % of the window with no client connected`,
    runObjectCount > MAX_DURABLE_OBJECTS_PER_RUN &&
      `the run touched ${runObjectCount} Durable Objects, above the cap of ${MAX_DURABLE_OBJECTS_PER_RUN}`,
    (input.account.windowMinutes.length >= DURABLE_OBJECT_ANALYTICS_ROW_LIMIT ||
      runObjectCount >= DURABLE_OBJECT_ANALYTICS_ROW_LIMIT) &&
      `the analytics answer hit its ${DURABLE_OBJECT_ANALYTICS_ROW_LIMIT}-row limit, so it cannot prove what is not resident`,
    runObjectCount === 0 &&
      "the analytics show no Durable Object the suite touched, so the gate cannot see this preview",
  ].filter((failure): failure is string => typeof failure === "string");
  return { window: input.window, residentDurableObjects, runObjectCount, failures };
}

/** The verdict as markdown: the job log prints it, the PR body carries it. At most `maxRows` table
 *  rows; the job log is given every one. */
export function renderDurableObjectResidency(
  verdict: DurableObjectResidencyVerdict,
  { maxRows = Infinity }: { maxRows?: number } = {},
): string {
  const time = (date: Date) => date.toISOString().slice(11, 16);
  const rows = verdict.residentDurableObjects.slice(0, maxRows);
  const hidden = verdict.residentDurableObjects.length - rows.length;
  return [
    verdict.failures.length === 0
      ? "#### Residency gate: passed"
      : `#### Residency gate: FAILED — ${verdict.failures.join("; ")}`,
    "",
    `Window ${time(verdict.window.start)}–${time(verdict.window.end)} UTC, five minutes after the suite ended · ${verdict.runObjectCount} Durable Objects touched by the suite (cap ${MAX_DURABLE_OBJECTS_PER_RUN}) · ${verdict.residentDurableObjects.length} resident for at least 80 % of the window. The release step redeploys the preview after this reading; an object still resident in the next run's window survived it.`,
    ...(rows.length > 0
      ? [
          "",
          "| Durable Object name | class | seconds resident of 300 | resident by design |",
          "| --- | --- | --- | --- |",
          ...rows.map(
            (object) =>
              `| \`${object.name || `(unnamed) ${object.objectId}`}\` | ${object.className} | ${object.residentSeconds} | ${object.residentByDesign || "no: a leak"} |`,
          ),
          ...(hidden > 0 ? [`| … and ${hidden} more in the job log | | | |`] : []),
        ]
      : []),
  ].join("\n");
}
