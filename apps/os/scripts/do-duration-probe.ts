// Defense-in-depth probe for the Durable Objects billable-duration leak class of
// bug (see apps/os/tasks/do-duration-leak/). Two independent checks against
// Cloudflare's GraphQL analytics, either of which prints a report and exits
// non-zero so a cron / CI step / monitoring job can alert:
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
//   doppler run --config prd        -- pnpm tsx apps/os/scripts/do-duration-probe.ts
//   doppler run --config preview_3  -- pnpm tsx apps/os/scripts/do-duration-probe.ts --hours 6
//
// Flags (env or CLI):
//   --hours N                 lookback window in hours (default 24)
//   --threshold-hours N       wallTimeP99 ceiling per invocation, in hours (default 1)
//   --prefix STR              only scripts whose name starts with STR (default "os-")
//   --max-account-do-hours N  account-wide active-time ceiling per hour, in
//                             DO-hours (default 500; a 128MB DO active for one
//                             hour = 1 DO-hour ≈ $0.006 duration)
//   --json                    human report moves to stderr; stdout carries one
//                             ProbeSummary JSON line (for the CI alert wrapper)

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing required env var ${name}`);
  return value;
}

function flag(name: string, fallback: number): number {
  const fromCli = process.argv.indexOf(`--${name}`);
  if (fromCli !== -1 && process.argv[fromCli + 1] !== undefined)
    return Number(process.argv[fromCli + 1]);
  return fallback;
}

function flagStr(name: string, fallback: string): string {
  const fromCli = process.argv.indexOf(`--${name}`);
  if (fromCli !== -1 && process.argv[fromCli + 1] !== undefined) return process.argv[fromCli + 1]!;
  return fallback;
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

export type ActiveTimeBreachRow = { hour: string; doHours: number };
export type PinnedInvocationRow = {
  date: string;
  script: string;
  wallTimeP99Hours: number;
  requests: number;
};
/** The machine-readable result printed as one JSON line under `--json`,
 * consumed by scripts/ci/do-duration-alert.ts to build the Slack message. */
export type ProbeSummary = {
  activeTime: { ceilingDoHours: number; breachedHours: ActiveTimeBreachRow[] };
  pinnedInvocations: { thresholdHours: number; rows: PinnedInvocationRow[] };
};

/** Check 2: account-wide DO active time per hour. */
async function checkAccountActiveTime(input: {
  accountTag: string;
  apiToken: string;
  lookbackHours: number;
  maxAccountDoHours: number;
}): Promise<ActiveTimeBreachRow[]> {
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
  // An empty series is never "quiet": both accounts have DO activity every
  // hour (prd's chronic baseline alone is ~120 DO-hours/hour), so no rows
  // means dataset lag, a wrong account tag, or a broken token. Fail loudly —
  // the alert wrapper reports a thrown probe as "FAILED to run" — instead of
  // exiting zero as if under the ceiling.
  if (rows.length === 0) {
    throw new Error(
      `no durableObjectsPeriodicGroups rows for account ${input.accountTag} in the last ` +
        `${input.lookbackHours}h — analytics lag or misconfiguration, not evidence of quiet`,
    );
  }
  const byHour = new Map<string, number>();
  for (const row of rows) {
    const hour = row.dimensions.datetimeHour;
    byHour.set(hour, (byHour.get(hour) || 0) + row.sum.activeTime);
  }
  // µs of 128MB-DO active time per hour → "DO-hours" (1 DO continuously active
  // for the hour). Cloudflare bills duration at $12.50/M GB-s; 1 DO-hour =
  // 0.125GB * 3600s = 450 GB-s ≈ $0.0056.
  return [...byHour.entries()]
    .map(([hour, activeTimeUs]) => ({ hour, doHours: Math.round(activeTimeUs / 3600e6) }))
    .filter((row) => row.doHours > input.maxAccountDoHours)
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

async function main(): Promise<void> {
  const accountTag = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const lookbackHours = flag("hours", 24);
  const thresholdHours = flag("threshold-hours", 1);
  const maxAccountDoHours = flag("max-account-do-hours", 500);
  const prefix = flagStr("prefix", "os-");
  // --json: the human report moves to stderr and stdout carries exactly one
  // ProbeSummary JSON line, for the CI alert wrapper.
  const json = process.argv.includes("--json");
  const report = json ? console.error : console.log;
  const thresholdMicros = thresholdHours * 3.6e9; // hours → microseconds

  const breachedHours = await checkAccountActiveTime({
    accountTag,
    apiToken,
    lookbackHours,
    maxAccountDoHours,
  });
  if (breachedHours.length === 0) {
    report(
      `✅ DO active-time probe clean: no hour in the last ${lookbackHours}h exceeded ` +
        `${maxAccountDoHours} account-wide DO-hours.`,
    );
  } else {
    process.exitCode = 1;
    report(
      `🚨 DO active-time probe: ${breachedHours.length} hour(s) in the last ${lookbackHours}h ` +
        `exceeded ${maxAccountDoHours} account-wide DO-hours — the runaway-fleet signature ` +
        `(alarm/wake loops keeping whole DO populations resident; see the 2026-09-01 preview ` +
        `incident in apps/os/tasks/do-duration-leak/). At $12.50/M GB-s, 1000 DO-hours ≈ $5.60.`,
    );
    for (const row of breachedHours) {
      report(
        `  - ${row.hour}  ${row.doHours} DO-hours (~$${(row.doHours * 0.005625).toFixed(0)}/h if sustained)`,
      );
    }
  }

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

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag, start, end } }),
  });
  const body = (await response.json()) as CfGraphqlResponse<{
    viewer: {
      accounts: Array<{
        durableObjectsInvocationsAdaptiveGroups: Array<{
          dimensions: { date: string; scriptName: string };
          sum: { requests: number };
          quantiles: { wallTimeP99: number };
        }>;
      }>;
    };
  }>;

  if (body.errors?.length) {
    throw new Error(`Cloudflare GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  const rows = body.data?.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
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
        `session pinning a Durable Object resident (see apps/os/tasks/do-duration-leak/).`,
    );
    for (const row of flagged) {
      report(
        `  - ${row.date}  ${row.script}  wallTimeP99=${row.wallTimeP99Hours}h  reqs=${row.requests}`,
      );
    }
  }

  if (json) {
    const summary: ProbeSummary = {
      activeTime: { ceilingDoHours: maxAccountDoHours, breachedHours },
      pinnedInvocations: { thresholdHours, rows: flagged },
    };
    console.log(JSON.stringify(summary));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
