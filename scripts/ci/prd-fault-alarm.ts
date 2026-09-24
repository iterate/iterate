// Prd fault alarm (prd-fault-alarm.yml, every 15 minutes): reads the last half hour of os-prd's
// Workers Logs and pages #error-pulse on any 5xx, a burst of platform-failure heals, or any error.
// On 2026-09-23 a Cloudflare fault let each first-party facet start answer ONE call for ~2.5 hours:
// ~1,800 heals and ~2,400 errors per half hour, 41 homepage 500s on lispwoso.com and garple.com —
// and our recovery kept most requests green, so only the logs knew.
//
// A workaround that heals a platform fault logs `console.warn({ event:
// "<area>.platform-failure-<action>", name, … })` (apps/os context/facet-host.ts); naming it so
// is all it takes to be alarmed.
//
//   doppler run --project os --config prd -- pnpm tsx scripts/ci/prd-fault-alarm.ts run
//   … run --at 2026-09-23T07:30:00Z --dry-run    # replay a window, post nothing
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { osEnvs, PRD_ACCOUNT_ID } from "../../envs.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";

const PRD_WORKER = osEnvs.prd!.workerName;

/** The prd account's Workers Logs API access. */
type CloudflareCredentials = { accountId: string; apiToken: string };

/** One window's rows per signal: [label, count], biggest first. */
export type FaultReading = Record<"serverErrors" | "heals" | "errors", [string, number][]>;

/** Reads the last half hour of os-prd's Workers Logs and pages #error-pulse on a fault. */
export async function run(options: { at?: string; dryRun?: boolean } = {}) {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
  if (!accountId || !apiToken) throw new Error("run under doppler --project os --config prd");
  const now = new Date();
  return alarm({
    now,
    windowEnd: options.at ? new Date(options.at) : now,
    cloudflare: { accountId, apiToken },
    // A dry run posts nothing, so it needs no Slack token.
    slack: options.dryRun ? null : getSlackClient,
  });
}

/**
 * Reads the half hour to `windowEnd` and, on a fault, pages #error-pulse unless a prd fault page
 * went out in the hour before `now`: a fault that lasts pages hourly, not every run. `slack: null`
 * posts nothing. Paged, it resolves to the page, so the run ends green: a scheduled run reports on
 * main's head commit, where red reads as "this commit broke". It throws only when it could not read
 * prd (readWindow) or post (the Slack client throws on an error).
 */
export async function alarm(input: {
  now: Date;
  windowEnd: Date;
  cloudflare: CloudflareCredentials;
  slack: (() => WebClient) | null;
}) {
  const reading = await readWindow(input.windowEnd, input.cloudflare);
  const page = renderFaultPage(reading, input.windowEnd);
  console.log(JSON.stringify({ windowEnd: input.windowEnd, reading }));
  if (!page || !input.slack) return page || `${PRD_WORKER} is quiet`;
  const slack = input.slack();
  const channel = slackChannelIds["#error-pulse"];
  const history = await slack.conversations.history({
    channel,
    oldest: String(input.now.getTime() / 1000 - 3600),
  });
  if (!history.messages?.some((m) => m.bot_id && m.text?.includes("prd fault page:")))
    await slack.chat.postMessage({ channel, text: page });
  return page;
}

/** The page for one window, or null when prd is quiet. Pure. */
export function renderFaultPage(reading: FaultReading, windowEnd: Date): string | null {
  const total = (rows: [string, number][]) => rows.reduce((sum, [, n]) => sum + n, 0);
  const tripped =
    total(reading.serverErrors) > 0 || // prd answers no 5xx on purpose since #2844
    total(reading.heals) >= 10 || // a lone blip heals a call or three; 2026-09-23 ran ~1,800
    total(reading.errors) > 0; // every error is a page; expected ones are filtered in readWindow
  if (!tripped) return null;
  const line = (what: string, rows: [string, number][], label: (raw: string) => string) => {
    const merged = new Map<string, number>();
    for (const [raw, n] of rows) merged.set(label(raw), (merged.get(label(raw)) ?? 0) + n);
    const top = [...merged].sort((a, b) => b[1] - a[1]).slice(0, 4);
    return rows.length && `• ${total(rows)} ${what}: ${top.map((row) => row.join(" ")).join(", ")}`;
  };
  return [
    // "prd fault page:" is how `alarm` finds the last page.
    `🚨 prd fault page: ${PRD_WORKER}, 30 min to ${windowEnd.toISOString().slice(11, 16)} UTC ${onCallMention}`,
    line("5xx responses", reading.serverErrors, (url) =>
      url.replace(/^https?:\/\/([^/]+).*$/, "$1"),
    ),
    line("platform-failure heals", reading.heals, (name) => name),
    line("errors", reading.errors, (m) =>
      m.replace(/reference = \w+/g, "reference = …").slice(0, 80),
    ),
    `<https://dash.cloudflare.com/${PRD_ACCOUNT_ID}/workers-and-pages/observability|Workers Logs>`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function readWindow(
  windowEnd: Date,
  { accountId, apiToken }: CloudflareCredentials,
): Promise<FaultReading> {
  // One grouped count per signal. Its rows sum to a lower bound (events without the grouped field,
  // or past 2,000 groups, drop out) — a burst still pages.
  const rows = async (filters: object[], groupBy: string): Promise<[string, number][]> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
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
              { key: "$metadata.service", operation: "eq", value: PRD_WORKER, type: "string" },
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
  // workerd#918: a Durable Object that answers before a request body is read can log
  // "Can't read from request stream after response has been sent." though the client got its
  // response. Scanners POSTing to project hosts raise it on ~3 % of chunked bodies even with the
  // fetch lane's pipe (#2871; the #2880 follow-up measured no effect). It pages only on `/api`
  // itself — the capnweb endpoint, a platform call, not a site visit (`/api/…` is a site's path).
  const unreadBody = "Can't read from request stream after response has been sent";
  const [serverErrors, heals, errors, apiUnreadBodyErrors] = await Promise.all([
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
        // A reset someone asked for (`itx.abort()`, apps/os context/built-ins.ts): the runtime
        // logs `ctx.abort` as an uncatchable error — two lines per reset, one more per socket it
        // closed (measured on a preview, 2026-09-23) — and the context's own log already records it
        // as `context/aborted`, attributed. An expected outcome, not a fault.
        {
          key: "$metadata.message",
          operation: "not_includes",
          value: "itx.abort() reset the context",
          type: "string",
        },
        { key: "$metadata.message", operation: "not_includes", value: unreadBody, type: "string" },
        // A deploy: the runtime resets every Durable Object on new code and logs it as an error on
        // each one it caught mid-call (14:32Z 2026-09-23). A request it failed still pages as a 5xx.
        {
          key: "$metadata.message",
          operation: "not_includes",
          value: "Durable Object reset because its code was updated",
          type: "string",
        },
      ],
      "$metadata.message",
    ),
    rows(
      [
        { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
        { key: "$metadata.message", operation: "includes", value: unreadBody, type: "string" },
        {
          key: "$workers.event.request.url",
          operation: "regex",
          value: "^https?://[^/]+/api(\\?|$)",
          type: "string",
        },
      ],
      "$metadata.message",
    ),
  ]);
  return { serverErrors, heals, errors: [...errors, ...apiUnreadBodyErrors] };
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-fault-alarm" }).run();
