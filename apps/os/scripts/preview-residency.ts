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
  // Empty. The six careless-facet fixtures once here (`live`, `rest`, `residency_careless_data`,
  // `_live`, `_sibling`, `residency_live_state_sink`) were a userspace facet keeping an env.ITX
  // value and outliving its context; a loaded facet holding no claim is now reset when its context
  // is reborn or has been quiet a minute (FacetHost `resetUnclaimedLoadedFacets`).
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

/** One query, five answers: the account's newest analytics minute and the preview's newest and
 *  oldest since the suite started (is the data in yet? durableObjectAnalyticsCoverWindow), every window minute of every object in the preview's namespaces, and every object the run touched
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
      previewNewestMinute: durableObjectsPeriodicGroups(limit: 1, filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $suiteStarted, datetime_leq: $readAt }, orderBy: [datetimeMinute_DESC]) {
        dimensions { datetimeMinute }
      }
      previewOldestMinute: durableObjectsPeriodicGroups(limit: 1, filter: { namespaceId_in: $namespaceIds, datetimeMinute_geq: $suiteStarted, datetime_leq: $readAt }, orderBy: [datetimeMinute_ASC]) {
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
          previewNewestMinute: z.array(
            z.object({ dimensions: z.object({ datetimeMinute: z.string() }) }),
          ),
          previewOldestMinute: z.array(
            z.object({ dimensions: z.object({ datetimeMinute: z.string() }) }),
          ),
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

/** Is the window's data in? Three conditions, all measured 2026-09-23:
 *  - The window's last minute is complete. A minute's rows keep landing after it ends: read one
 *    minute after the window, its last minute was missing 10 of 22 resident objects; read two
 *    minutes after, it held all 22. So the account must report the minute that starts one minute
 *    after the window ends.
 *  - The PREVIEW'S OWN namespaces are ingested as far as the suite's end. A new preview's data can
 *    trail the account's by a quarter of an hour: `main-6b39ca9` showed no row at all at 16:11 for a
 *    suite that ended at 15:59, while the account was current to 16:10, and hundreds by 16:14. So
 *    the preview must report the minute before the one the suite ended in (the suite ran until then).
 *  - ...and BACK to the suite's start: a new preview's first minutes can arrive after its later
 *    ones. At 17:56 `pr2923-os-main-e2e-de-6dcbc1` reported rows from 17:43 to 17:54 but none for
 *    17:41–17:42, the suite's two minutes, which later held 591 objects. So the preview's oldest row
 *    since the suite started must be in the suite's first minute or the one after (a suite starting
 *    in a minute's last seconds may touch its first object in the next).
 *  An idle account reports no minute at all, which is why the caller also stops waiting at a
 *  deadline, and rule 8 then fails a run the analytics never showed. */
export function durableObjectAnalyticsCoverWindow(
  account: DurableObjectResidencyAccount,
  window: { end: Date },
  suite: { started: Date; ended: Date },
): boolean {
  const newest = account.newestMinute[0]?.dimensions.datetimeMinute;
  const previewNewest = account.previewNewestMinute[0]?.dimensions.datetimeMinute;
  const previewOldest = account.previewOldestMinute[0]?.dimensions.datetimeMinute;
  if (!newest || !previewNewest || !previewOldest) return false;
  const minuteOf = (date: Date) => Math.floor(date.getTime() / 60_000) * 60_000;
  return (
    Date.parse(newest) >= window.end.getTime() + 60_000 &&
    Date.parse(previewNewest) >= minuteOf(suite.ended) - 60_000 &&
    Date.parse(previewOldest) <= minuteOf(suite.started) + 60_000
  );
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
