// Prd fault alarm (prd-fault-alarm.yml, every 15 minutes): reads the last half hour of os-next-prd's
// Workers Logs and pages #error-pulse on any 5xx, a burst of platform-failure heals, or a burst of
// errors. On 2026-09-23 a Cloudflare fault let each first-party facet start answer ONE call for
// ~2.5 hours: ~1,800 heals and ~2,400 errors per half hour, 41 homepage 500s on lispwoso.com and
// garple.com — and our recovery kept most requests green, so only the logs knew.
//
// A workaround that heals a platform fault logs `console.warn({ event:
// "<area>.platform-failure-<action>", name, … })` (apps/os-next context/facet-host.ts); naming it so
// is all it takes to be alarmed.
//
//   doppler run --project project-worker --config prd -- pnpm tsx scripts/ci/prd-fault-alarm.ts run
//   … run --at 2026-09-23T07:30:00Z --dry-run    # replay a window, post nothing
import { createCli } from "trpc-cli";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

/** One window's rows per signal: [label, count], biggest first. */
export type FaultReading = Record<"serverErrors" | "heals" | "errors", [string, number][]>;

export async function run(options: { at?: string; dryRun?: boolean } = {}) {
  const windowEnd = options.at ? new Date(options.at) : new Date();
  const reading = await readWindow(windowEnd);
  const page = renderFaultPage(reading, windowEnd);
  console.log(JSON.stringify({ windowEnd, reading }));
  if (!page || options.dryRun) return page || "os-next-prd is quiet";
  const slack = getSlackClient();
  const channel = slackChannelIds["#error-pulse"];
  // A fault that lasts pages hourly, not every run.
  const history = await slack.conversations.history({
    channel,
    oldest: String(Date.now() / 1000 - 3600),
  });
  if (!history.messages?.some((m) => m.bot_id && m.text?.includes("prd fault page:")))
    await slack.chat.postMessage({ channel, text: page });
  throw new Error(`prd fault alarm tripped:\n${page}`); // a red run too, like the DO duration alarm
}

/** The page for one window, or null when prd is quiet. Pure. */
export function renderFaultPage(reading: FaultReading, windowEnd: Date): string | null {
  const total = (rows: [string, number][]) => rows.reduce((sum, [, n]) => sum + n, 0);
  const tripped =
    total(reading.serverErrors) > 0 || // prd answers no 5xx on purpose since #2844
    total(reading.heals) >= 10 || // a lone blip heals a call or three; 2026-09-23 ran ~1,800
    total(reading.errors) >= 10; // the quiet baseline was 8 in 2.5 hours
  if (!tripped) return null;
  const line = (what: string, rows: [string, number][], label: (raw: string) => string) => {
    const merged = new Map<string, number>();
    for (const [raw, n] of rows) merged.set(label(raw), (merged.get(label(raw)) ?? 0) + n);
    const top = [...merged].sort((a, b) => b[1] - a[1]).slice(0, 4);
    return rows.length && `• ${total(rows)} ${what}: ${top.map((row) => row.join(" ")).join(", ")}`;
  };
  return [
    // "prd fault page:" is how `run` finds the last page; the mention is Jonas (./slack.ts).
    `🚨 prd fault page: os-next-prd, 30 min to ${windowEnd.toISOString().slice(11, 16)} UTC <@U067G4QRFK2>`,
    line("5xx responses", reading.serverErrors, (url) =>
      url.replace(/^https?:\/\/([^/]+).*$/, "$1"),
    ),
    line("platform-failure heals", reading.heals, (name) => name),
    line("errors", reading.errors, (m) =>
      m.replace(/reference = \w+/g, "reference = …").slice(0, 80),
    ),
    "<https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readWindow(windowEnd: Date): Promise<FaultReading> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
  if (!account || !token)
    throw new Error("run under doppler --project project-worker --config prd");
  // One grouped count per signal. Its rows sum to a lower bound (events without the grouped field,
  // or past 2,000 groups, drop out) — a burst still pages.
  const rows = async (filters: object[], groupBy: string): Promise<[string, number][]> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          queryId: "prd-fault-alarm",
          view: "calculations",
          timeframe: { from: windowEnd.getTime() - 30 * 60_000, to: windowEnd.getTime() },
          parameters: {
            datasets: ["cloudflare-workers"],
            calculations: [{ operator: "count" }],
            groupBys: [{ type: "string", value: groupBy }],
            orderBy: { value: "count", order: "desc" },
            limit: 2000,
            filters: [
              { key: "$metadata.service", operation: "eq", value: "os-next-prd", type: "string" },
              ...filters,
            ],
          },
        }),
      },
    );
    const body = (await response.json()) as {
      success: boolean;
      errors: unknown;
      result: { calculations: { aggregates: { groupKey: string; count: number }[] }[] };
    };
    // A broken token or a renamed field must fail the run, never read as a quiet prd.
    if (!body.success) throw new Error(`Workers Logs query failed: ${JSON.stringify(body.errors)}`);
    return body.result.calculations[0]!.aggregates.map((row) => [row.groupKey, row.count]);
  };
  const [serverErrors, heals, errors] = await Promise.all([
    rows(
      [{ key: "$workers.event.response.status", operation: "gte", value: 500, type: "number" }],
      "$workers.event.request.url",
    ),
    rows(
      [{ key: "event", operation: "includes", value: "platform-failure", type: "string" }],
      "name",
    ),
    rows(
      [
        { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
        // A reset someone asked for (`itx.abort()`, apps/os-next context/built-ins.ts): the runtime
        // logs `ctx.abort` as an uncatchable error — two lines per reset, one more per socket it
        // closed (measured on a preview, 2026-09-23) — and the context's own log already records it
        // as `context/aborted`, attributed. An expected outcome, not a fault.
        {
          key: "$metadata.message",
          operation: "not_includes",
          value: "itx.abort() reset the context",
          type: "string",
        },
      ],
      "$metadata.message",
    ),
  ]);
  return { serverErrors, heals, errors };
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-fault-alarm" }).run();
