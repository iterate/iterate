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
  const body = (await response.json()) as CfGraphqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Cloudflare GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error("Cloudflare GraphQL returned no data");
  return body.data;
}

/** Check 2: account-wide DO active time per hour. Returns true when breached. */
async function checkAccountActiveTime(input: {
  accountTag: string;
  apiToken: string;
  lookbackHours: number;
  maxAccountDoHours: number;
}): Promise<boolean> {
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

  const byHour = new Map<string, number>();
  for (const row of data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? []) {
    const hour = row.dimensions.datetimeHour;
    byHour.set(hour, (byHour.get(hour) || 0) + row.sum.activeTime);
  }
  // µs of 128MB-DO active time per hour → "DO-hours" (1 DO continuously active
  // for the hour). Cloudflare bills duration at $12.50/M GB-s; 1 DO-hour =
  // 0.125GB * 3600s = 450 GB-s ≈ $0.0056.
  const breachedHours = [...byHour.entries()]
    .map(([hour, activeTimeUs]) => ({ hour, doHours: activeTimeUs / 3600e6 }))
    .filter((row) => row.doHours > input.maxAccountDoHours)
    .sort((a, b) => a.hour.localeCompare(b.hour));

  if (breachedHours.length === 0) {
    console.log(
      `✅ DO active-time probe clean: no hour in the last ${input.lookbackHours}h exceeded ` +
        `${input.maxAccountDoHours} account-wide DO-hours.`,
    );
    return false;
  }
  console.error(
    `🚨 DO active-time probe: ${breachedHours.length} hour(s) in the last ${input.lookbackHours}h ` +
      `exceeded ${input.maxAccountDoHours} account-wide DO-hours — the runaway-fleet signature ` +
      `(alarm/wake loops keeping whole DO populations resident; see the 2026-09-01 preview ` +
      `incident in apps/os/tasks/do-duration-leak/). At $12.50/M GB-s, 1000 DO-hours ≈ $5.60.`,
  );
  for (const row of breachedHours) {
    console.error(
      `  - ${row.hour}  ${Math.round(row.doHours)} DO-hours (~$${(row.doHours * 0.005625).toFixed(0)}/h if sustained)`,
    );
  }
  return true;
}

async function main(): Promise<void> {
  const accountTag = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const lookbackHours = flag("hours", 24);
  const thresholdHours = flag("threshold-hours", 1);
  const maxAccountDoHours = flag("max-account-do-hours", 500);
  const prefix = flagStr("prefix", "os-");
  const thresholdMicros = thresholdHours * 3.6e9; // hours → microseconds

  const activeTimeBreached = await checkAccountActiveTime({
    accountTag,
    apiToken,
    lookbackHours,
    maxAccountDoHours,
  });
  if (activeTimeBreached) process.exitCode = 1;

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
    console.log(
      `✅ DO duration probe clean: no ${prefix}* script in the last ${lookbackHours}h had a ` +
        `single invocation over ${thresholdHours}h wall-clock (the pinned-DO signature).`,
    );
    return;
  }

  console.error(
    `🚨 DO duration probe: ${flagged.length} ${prefix}* script-day(s) show a DO invocation running ` +
      `longer than ${thresholdHours}h of wall-clock — the signature of a leaked cross-isolate RPC ` +
      `session pinning a Durable Object resident (see apps/os/tasks/do-duration-leak/).`,
  );
  for (const row of flagged) {
    console.error(
      `  - ${row.date}  ${row.script}  wallTimeP99=${row.wallTimeP99Hours}h  reqs=${row.requests}`,
    );
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
