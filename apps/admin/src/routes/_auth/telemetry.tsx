// /telemetry — the platform's live metrics (docs/telemetry.md "Reading"): each panel one flat
// Analytics Engine SQL query over the hours the URL names, read in the app's Worker with its metrics
// token (APP_CONFIG `metrics`), charted with TanStack Charts, and footed with what it covered and
// what it cost.
import { colorLegend, defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { tooltip } from "@tanstack/charts/tooltip";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { z } from "zod";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";

/** THE PANELS, each over `iterate_metrics` (docs/telemetry.md "Metrics": blob1…6 are name, kind,
 *  worker, project, path and labels, double1 the value), weighted by `_sample_interval` since
 *  Analytics Engine samples, and `reads` the metric it covers (every one when unset). `{hours}` is
 *  the range, and a chart's bucket `t` is as many minutes, so it has 60 points. */
const PANELS: { title: string; reads?: string; sql: string }[] = [
  {
    title: "subscription.delivery_ms p50 and p99 (ms)",
    reads: "subscription.delivery_ms",
    sql: "SELECT toStartOfInterval(timestamp, INTERVAL '{hours}' MINUTE) AS t, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.99)(double1, _sample_interval) AS p99 FROM iterate_metrics WHERE blob1 = 'subscription.delivery_ms' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY t ORDER BY t",
  },
  {
    title: "subscription.pending, the ten deepest rows",
    reads: "subscription.pending",
    sql: "SELECT blob4 AS project_id, blob5 AS path, blob6 AS labels, max(double1) AS max FROM iterate_metrics WHERE blob1 = 'subscription.pending' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY project_id, path, labels HAVING max > 0 ORDER BY max DESC LIMIT 10",
  },
  {
    title: "subscription.retries per minute",
    reads: "subscription.retries",
    sql: "SELECT toStartOfInterval(timestamp, INTERVAL '{hours}' MINUTE) AS t, sum(_sample_interval * double1) / {hours} AS retries FROM iterate_metrics WHERE blob1 = 'subscription.retries' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY t ORDER BY t",
  },
  {
    title: "Metric points per worker",
    sql: "SELECT blob3 AS worker, sum(_sample_interval) AS points, count() AS stored FROM iterate_metrics WHERE timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY worker ORDER BY points DESC LIMIT 20",
  },
];

/** WHAT EACH PANEL COVERS: every metric's stored points in the range, and the points they stand
 *  for. Analytics Engine answers with no count of what a query read, so this is the measure. */
const CENSUS =
  "SELECT blob1 AS name, count() AS stored, sum(_sample_interval) AS written FROM iterate_metrics WHERE timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY name";

/** Analytics Engine bills a read query $1.00 per million past the million a month included, whatever
 *  it reads (https://developers.cloudflare.com/analytics/analytics-engine/pricing/); it bills
 *  nothing yet. */
const QUERY_USD = 1 / 1_000_000;

const Hours = z.number().int().min(1).max(168);
/** Analytics Engine's `FORMAT JSON` answer: a UInt64 comes as a string, a Float64 as a number. */
const AnalyticsEngineAnswer = z.object({
  data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
});
type Row = z.infer<typeof AnalyticsEngineAnswer>["data"][number];

/** Every panel's rows and the census, or null without a metrics token, for a platform admin alone: this browser's
 *  session at the deployment's own issuer holds the `admin` scope, which that issuer grants to its
 *  `admins` only (apps/os consent.ts). A session connected to another issuer could hold any scope. */
const readPanels = createServerFn({ method: "GET" })
  .inputValidator(Hours)
  .handler(async ({ data: hours }) => {
    const { env } = await import("cloudflare:workers");
    const { getRequest } = await import("@tanstack/react-start/server");
    const { appSession } = await import("iterate/app-server");
    const config = startAppConfigOf(env);
    const session = appSession(env.BROWSER_SESSION, getRequest());
    const [host, scopes, bearer] = await Promise.all([
      session?.host(),
      session?.scopes(),
      session?.bearer(),
    ]);
    if (host?.issuer !== config.urls.os || !scopes?.includes("admin") || !bearer)
      throw new Error("Telemetry is for platform admins: sign in with the admin scope.");
    if (!config.metrics?.apiToken) return null;
    const { accountId, apiToken } = config.metrics;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
    const read = async (title: string, sql: string) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}` },
        body: `${sql.replaceAll("{hours}", String(hours))} FORMAT JSON`,
      });
      if (!response.ok)
        throw new Error(
          `${title}: Analytics Engine answered ${response.status}: ${await response.text()}`,
        );
      return AnalyticsEngineAnswer.parse(await response.json()).data;
    };
    const [census, ...panels] = await Promise.all([
      read("census", CENSUS),
      ...PANELS.map(({ title, sql }) => read(title, sql)),
    ]);
    // the charts end at the moment of the read, on the server and in the browser alike
    return { at: Date.now(), census: census!, panels };
  });

export const Route = createFileRoute("/_auth/telemetry")({
  validateSearch: z.object({ hours: Hours.default(1).catch(1) }),
  loaderDeps: ({ search }) => ({ hours: search.hours }),
  loader: ({ deps }) => readPanels({ data: deps.hours }),
  head: () => ({ meta: [{ title: "Telemetry · Admin" }] }),
  component: TelemetryPage,
});

function TelemetryPage() {
  const read = Route.useLoaderData();
  const { hours } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Telemetry</h1>
        <NativeSelect
          aria-label="Time range"
          value={hours}
          onChange={(event) => void navigate({ search: { hours: Number(event.target.value) } })}
        >
          <NativeSelectOption value={1}>Last hour</NativeSelectOption>
          <NativeSelectOption value={6}>Last 6 hours</NativeSelectOption>
          <NativeSelectOption value={24}>Last 24 hours</NativeSelectOption>
          <NativeSelectOption value={168}>Last 7 days</NativeSelectOption>
        </NativeSelect>
      </div>
      {read ? (
        <>
          <p className="text-xs text-muted-foreground">
            {PANELS.length + 1} Analytics Engine queries, the census of what each panel covers
            included: {usd((PANELS.length + 1) * QUERY_USD)} at $1.00 per million. Analytics Engine
            bills per query, whatever it reads, and bills nothing yet.
          </p>
          {PANELS.map(({ title, reads }, index) => {
            const covered = read.census.filter((row) => !reads || row.name === reads);
            const sum = (column: string) =>
              covered.reduce((total, row) => total + Number(row[column]), 0);
            return (
              <section key={title} className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{title}</h2>
                <Panel title={title} rows={read.panels[index]!} hours={hours} at={read.at} />
                <p className="text-xs text-muted-foreground">
                  {format(sum("stored"))} stored points, standing for {format(sum("written"))} · 1
                  query, {usd(QUERY_USD)}
                </p>
              </section>
            );
          })}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This deployment has no metrics token (Doppler APP_CONFIG_METRICS__API_TOKEN).
        </p>
      )}
    </div>
  );
}

/** Categorical slots 1 and 2 of the validated default data-viz palette, light mode. */
const COLORS = ["#2a78d6", "#eb6834"];

/** A panel's rows as a table or, when they have a bucket `t` (UTC), as one line per other column
 *  across the range up to the read, every bucket a point. */
function Panel({
  title,
  rows,
  hours,
  at,
}: {
  title: string;
  rows: Row[];
  hours: number;
  at: number;
}) {
  const chart = useMemo(() => {
    if (!rows[0] || !("t" in rows[0])) return undefined;
    const series = Object.keys(rows[0]).filter((column) => column !== "t");
    const time = new Intl.DateTimeFormat("en-GB", {
      ...(hours > 24 && { weekday: "short" }),
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    const points = rows.flatMap((row) =>
      series.map((name) => ({
        t: Date.parse(`${String(row.t).replace(" ", "T")}Z`),
        series: name,
        value: Number(row[name]),
      })),
    );
    return defineChart({
      marks: [lineY(points, { x: "t", y: "value", z: "series", points: true })],
      scales: {
        x: {
          scale: scaleLinear().domain([at - hours * 3_600_000, at]),
          axis: { ticks: { format: (ms) => `${time.format(ms)} UTC` } },
        },
        y: { scale: scaleLinear, nice: true, grid: true },
      },
      color: {
        scale: scaleOrdinal<string, string>().domain(series).range(COLORS),
        legend: colorLegend(),
      },
      tooltip,
    });
  }, [rows, hours, at]);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No points.</p>;
  if (chart) return <Chart definition={chart} height={220} ariaLabel={title} />;
  const columns = Object.keys(rows[0]!);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column}>{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {columns.map((column) => (
              <TableCell key={column} className="font-mono text-xs">
                {format(row[column])}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const usd = (amount: number) => `$${amount.toFixed(6)}`;

function format(value: Row[string]) {
  return typeof value === "number"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : String(value || "");
}
