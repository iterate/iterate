// Defense-in-depth probe for the Durable Objects billable-duration leak class of
// bug (see https://github.com/iterate/iterate/tree/6a9a48e2a/apps/os/tasks/do-duration-leak).
// Two independent checks against Cloudflare's GraphQL analytics, either of which
// prints a report and exits non-zero so a cron / CI step / monitoring job can alert:
//
// 1. The pinned-DO signature — a single DO invocation running for HOURS of
//    wall-clock at ~0 CPU — which is how a leaked cross-isolate RPC session
//    shows up in billing.
// 2. The runaway-fleet signature — account-wide DO active time in any one hour
//    above a ceiling. This is how the 2026-09-01 preview incident looked:
//    tens of thousands of stream DOs each waking every ~10s never trip a
//    per-invocation P99, but the account burned >20,000 DO-hours per hour
//    (~$3k+/day) until the slots were erased.
//
// Run it under a Doppler config that carries CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ACCOUNT_ID (the same creds the deploy uses):
//
//   doppler run --config prd        -- pnpm tsx scripts/ci/do-duration-probe.ts
//   doppler run --config preview_3  -- pnpm tsx scripts/ci/do-duration-probe.ts --hours 6
//
// Flags:
//   --hours N                 lookback window in hours (default 24)
//   --threshold-hours N       wallTimeP99 ceiling per invocation, in hours (default 1)
//   --prefix STR              only scripts whose name starts with STR (default "os-")
//   --max-account-do-hours N  account-wide active-time ceiling per hour, in
//                             DO-hours (default 500; a 128MB DO active for one
//                             hour = 1 DO-hour ≈ $0.006 duration)
//   --json                    human report moves to stderr; stdout carries one
//                             ProbeSummary JSON line (for the CI alert wrapper)

import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

interface CfGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function cfGraphql<T>(input: {
  apiToken: string;
  query: string;
  variables: Record<string, string>;
}): Promise<T> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  // Cloudflare's GraphQL endpoint always answers with a `{ data, errors }`
  // envelope; `data`'s shape is whatever the query above selected, which is
  // what T describes per call site. Nothing validates it at runtime — a
  // schema drift surfaces as a thrown "GraphQL errors" below or as NaN maths
  // in the caller, both of which fail the probe loudly rather than silently.
  const body = (await response.json()) as CfGraphqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Cloudflare GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error("Cloudflare GraphQL returned no data");
  return body.data;
}

type ActiveTimeRow = { hour: string; doHours: number };
type NamespaceActiveTimeRow = { namespace: string; doHours: number };
type PinnedInvocationRow = {
  date: string;
  script: string;
  wallTimeP99Hours: number;
  requests: number;
};
/** The machine-readable result printed as one JSON line under `--json`,
 * consumed by scripts/ci/do-duration-alert.ts to build the Slack message. */
export type ProbeSummary = {
  activeTime: {
    ceilingDoHours: number;
    /** Every hour of the lookback that had any DO activity, oldest first. */
    hours: ActiveTimeRow[];
    breachedHours: ActiveTimeRow[];
    /** The trailing 60 minutes' five biggest namespaces: who is spending. */
    topNamespaces: NamespaceActiveTimeRow[];
  };
  pinnedInvocations: { thresholdHours: number; rows: PinnedInvocationRow[] };
};

/** Check 2: account-wide DO active time per hour. */
async function checkAccountActiveTime(input: {
  accountTag: string;
  apiToken: string;
  lookbackHours: number;
  maxAccountDoHours: number;
}): Promise<{ hours: ActiveTimeRow[]; breachedHours: ActiveTimeRow[] }> {
  const query = `
    query DoActiveTimeProbe($accountTag: string!, $start: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsPeriodicGroups(
            limit: 5000
            filter: { datetimeHour_geq: $start }
          ) {
            dimensions { datetimeHour }
            sum { activeTime }
          }
        }
      }
    }`;
  const start = new Date(Date.now() - input.lookbackHours * 3600_000).toISOString();
  const data = await cfGraphql<{
    viewer: {
      accounts: Array<{
        durableObjectsPeriodicGroups: Array<{
          dimensions: { datetimeHour: string };
          sum: { activeTime: number };
        }>;
      }>;
    };
  }>({ apiToken: input.apiToken, query, variables: { accountTag: input.accountTag, start } });

  const rows = data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? [];
  // An empty series CAN be quiet: with no preview in use (a closed PR's is
  // deleted), dev/preview has no DO activity at all overnight, and this
  // dataset drops a deleted namespace's history retroactively. But it can
  // also be a wrong account tag or a broken token, which must not pass as
  // "under the ceiling". Tell them apart with a call that does not depend on
  // activity: the account's DO namespace listing answers with the same
  // credentials whether or not anything ran.
  if (rows.length === 0) {
    await proveCredentials(input);
  }
  const byHour = new Map<string, number>();
  for (const row of rows) {
    const hour = row.dimensions.datetimeHour;
    byHour.set(hour, (byHour.get(hour) || 0) + row.sum.activeTime);
  }
  // µs of 128MB-DO active time per hour → "DO-hours" (1 DO continuously active
  // for the hour). Cloudflare bills duration at $12.50/M GB-s; 1 DO-hour =
  // 0.125GB * 3600s = 450 GB-s ≈ $0.0056.
  const hours = [...byHour.entries()]
    .map(([hour, activeTimeUs]) => ({ hour, doHours: Math.round(activeTimeUs / 3600e6) }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  return { hours, breachedHours: hours.filter((row) => row.doHours > input.maxAccountDoHours) };
}

/**
 * The trailing 60 minutes' five biggest DO namespaces by active time, named
 * as the account's namespace listing names them: `<script>_<class>`
 * (`pr2828-a1b2c3d-os_IterateContextDurableObject` for a per-commit deployment;
 * a legacy Worker Preview's had its slug in between, `os_pr2828_…`).
 * DO-hours in the trailing hour are DO-hours per hour, so the alert can put
 * a $/h on each.
 */
async function topNamespacesInTrailingHour(input: {
  accountTag: string;
  apiToken: string;
}): Promise<NamespaceActiveTimeRow[]> {
  const query = `
    query DoTopNamespacesProbe($accountTag: string!, $since: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsPeriodicGroups(
            limit: 5
            filter: { datetimeMinute_geq: $since }
            orderBy: [sum_activeTime_DESC]
          ) {
            dimensions { namespaceId }
            sum { activeTime }
          }
        }
      }
    }`;
  const since = new Date(Date.now() - 3600_000).toISOString();
  const data = await cfGraphql<{
    viewer: {
      accounts: Array<{
        durableObjectsPeriodicGroups: Array<{
          dimensions: { namespaceId: string };
          sum: { activeTime: number };
        }>;
      }>;
    };
  }>({ apiToken: input.apiToken, query, variables: { accountTag: input.accountTag, since } });
  const rows = data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? [];
  if (rows.length === 0) return [];
  // One page of the listing: dev/preview holds ~400 namespaces. A namespace
  // past it keeps its bare id rather than paging through the whole account.
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountTag}/workers/durable_objects/namespaces?per_page=1000`,
    { headers: { Authorization: `Bearer ${input.apiToken}` } },
  );
  // Only `id` and `name` are read. A listing that fails or drifts in shape
  // leaves every namespace under its bare id: less readable, never a wrong
  // number and never a lost reading.
  const listing = z
    .object({ result: z.array(z.object({ id: z.string(), name: z.string() })) })
    .safeParse(await response.json().catch(() => null));
  const names = new Map(
    (listing.success ? listing.data.result : []).map((namespace) => [namespace.id, namespace.name]),
  );
  return rows.map((row) => ({
    namespace: names.get(row.dimensions.namespaceId) || row.dimensions.namespaceId,
    doHours: Math.round(row.sum.activeTime / 3600e6),
  }));
}

async function proveCredentials(input: { accountTag: string; apiToken: string }): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountTag}/workers/durable_objects/namespaces?per_page=1`,
    { headers: { Authorization: `Bearer ${input.apiToken}` } },
  );
  // Cloudflare's REST API always answers with a `{ success, errors }`
  // envelope; the asserted shape is that envelope and only `success` is
  // read. Nothing validates it at runtime, like cfGraphql above: if the
  // shape ever drifts, `success` reads as undefined — falsy — and this
  // throws, so a drift fails the probe loudly rather than passing as quiet.
  const body = (await response.json()) as { success: boolean; errors: Array<{ message: string }> };
  if (!body.success) {
    throw new Error(
      `no durableObjectsPeriodicGroups rows for account ${input.accountTag} AND the DO namespace ` +
        `listing failed (${body.errors.map((e) => e.message).join("; ") || response.status}) — ` +
        `misconfiguration, not quiet`,
    );
  }
}

/** Both checks against Cloudflare's GraphQL analytics (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID);
 *  exits 1 when either finds its signature, or when the probe itself fails. */
export default async function doDurationProbe(
  options: {
    /** Lookback window in hours. */
    hours?: number;
    /** wallTimeP99 ceiling per invocation, in hours. */
    thresholdHours?: number;
    /** Only scripts whose name starts with this. */
    prefix?: string;
    /** Account-wide active-time ceiling per hour, in DO-hours. */
    maxAccountDoHours?: number;
    /** The human report moves to stderr; stdout carries one ProbeSummary JSON line. */
    json?: boolean;
  } = {},
): Promise<void> {
  try {
    await probe(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (process.exitCode === 1) process.exit(1);
}

async function probe(options: {
  hours?: number;
  thresholdHours?: number;
  prefix?: string;
  maxAccountDoHours?: number;
  json?: boolean;
}): Promise<void> {
  const accountTag = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const lookbackHours = options.hours ?? 24;
  const thresholdHours = options.thresholdHours ?? 1;
  const maxAccountDoHours = options.maxAccountDoHours ?? 500;
  const prefix = options.prefix || "os-";
  // --json: the human report moves to stderr and stdout carries exactly one
  // ProbeSummary JSON line, for the CI alert wrapper.
  const json = options.json ?? false;
  const report = json ? console.error : console.log;
  const thresholdMicros = thresholdHours * 3.6e9; // hours → microseconds

  const { hours, breachedHours } = await checkAccountActiveTime({
    accountTag,
    apiToken,
    lookbackHours,
    maxAccountDoHours,
  });
  if (breachedHours.length === 0) {
    report(
      `✅ DO active-time probe clean: no hour in the last ${lookbackHours}h exceeded ` +
        `${maxAccountDoHours} account-wide DO-hours (${hours.length} hour(s) with any activity).`,
    );
  } else {
    process.exitCode = 1;
    report(
      `🚨 DO active-time probe: ${breachedHours.length} hour(s) in the last ${lookbackHours}h ` +
        `exceeded ${maxAccountDoHours} account-wide DO-hours — the runaway-fleet signature ` +
        `(alarm/wake loops keeping whole DO populations resident; see the 2026-09-01 preview ` +
        `incident, https://github.com/iterate/iterate/tree/6a9a48e2a/apps/os/tasks/do-duration-leak). At $12.50/M GB-s, 1000 DO-hours ≈ $5.60.`,
    );
    for (const row of breachedHours) {
      report(
        `  - ${row.hour}  ${row.doHours} DO-hours (~$${(row.doHours * 0.005625).toFixed(0)}/h if sustained)`,
      );
    }
  }
  const topNamespaces = await topNamespacesInTrailingHour({ accountTag, apiToken });
  report("Top DO namespaces, trailing hour (DO-hours):");
  for (const row of topNamespaces) report(`  - ${row.namespace}  ${row.doHours}`);

  // Cloudflare keeps adaptive analytics for the trailing window; query by day so
  // the schema accepts the filter, then keep only scripts over the ceiling.
  const start = new Date(Date.now() - lookbackHours * 3600_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const query = `
    query DoDurationProbe($accountTag: string!, $start: Date!, $end: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          durableObjectsInvocationsAdaptiveGroups(
            limit: 500
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date scriptName }
            sum { requests }
            quantiles { wallTimeP99 }
          }
        }
      }
    }`;

  const data = await cfGraphql<{
    viewer: {
      accounts: Array<{
        durableObjectsInvocationsAdaptiveGroups: Array<{
          dimensions: { date: string; scriptName: string };
          sum: { requests: number };
          quantiles: { wallTimeP99: number };
        }>;
      }>;
    };
  }>({ apiToken, query, variables: { accountTag, start, end } });

  const rows = data.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
  const flagged = rows
    .filter((r) => r.dimensions.scriptName.startsWith(prefix))
    .filter((r) => r.quantiles.wallTimeP99 > thresholdMicros)
    .map((r) => ({
      date: r.dimensions.date,
      script: r.dimensions.scriptName,
      wallTimeP99Hours: +(r.quantiles.wallTimeP99 / 3.6e9).toFixed(2),
      requests: r.sum.requests,
    }))
    .sort((a, b) => b.wallTimeP99Hours - a.wallTimeP99Hours);

  if (flagged.length === 0) {
    report(
      `✅ DO duration probe clean: no ${prefix}* script in the last ${lookbackHours}h had a ` +
        `single invocation over ${thresholdHours}h wall-clock (the pinned-DO signature).`,
    );
  } else {
    process.exitCode = 1;
    report(
      `🚨 DO duration probe: ${flagged.length} ${prefix}* script-day(s) show a DO invocation running ` +
        `longer than ${thresholdHours}h of wall-clock — the signature of a leaked cross-isolate RPC ` +
        `session pinning a Durable Object resident (see https://github.com/iterate/iterate/tree/6a9a48e2a/apps/os/tasks/do-duration-leak).`,
    );
    for (const row of flagged) {
      report(
        `  - ${row.date}  ${row.script}  wallTimeP99=${row.wallTimeP99Hours}h  reqs=${row.requests}`,
      );
    }
  }

  if (json) {
    const summary: ProbeSummary = {
      activeTime: { ceilingDoHours: maxAccountDoHours, hours, breachedHours, topNamespaces },
      pinnedInvocations: { thresholdHours, rows: flagged },
    };
    console.log(JSON.stringify(summary));
  }
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "do-duration-probe" }).run();
