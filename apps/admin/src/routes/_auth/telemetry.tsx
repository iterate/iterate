// /telemetry — the platform's live metrics (docs/telemetry.md "Reading"): each panel one flat
// Analytics Engine SQL query over the hours the URL names, read in the app's Worker with its metrics
// token (APP_CONFIG `metrics`).
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
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

/** THE PANELS by title, each over `iterate_metrics` (docs/telemetry.md "Metrics": blob1…6 are name,
 *  kind, worker, project, path and labels, double1 the value), weighted by `_sample_interval` since
 *  Analytics Engine samples. `{hours}` is the range, and a chart's bucket `t` is as many minutes, so
 *  it has 60 points. */
const PANELS = {
  "subscription.delivery_ms p50 and p99 (ms)":
    "SELECT toStartOfInterval(timestamp, INTERVAL '{hours}' MINUTE) AS t, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.99)(double1, _sample_interval) AS p99 FROM iterate_metrics WHERE blob1 = 'subscription.delivery_ms' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY t ORDER BY t",
  "subscription.pending, the ten deepest rows":
    "SELECT blob4 AS project_id, blob5 AS path, blob6 AS labels, max(double1) AS max FROM iterate_metrics WHERE blob1 = 'subscription.pending' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY project_id, path, labels HAVING max > 0 ORDER BY max DESC LIMIT 10",
  "subscription.retries per minute":
    "SELECT toStartOfInterval(timestamp, INTERVAL '{hours}' MINUTE) AS t, sum(_sample_interval * double1) / {hours} AS retries FROM iterate_metrics WHERE blob1 = 'subscription.retries' AND timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY t ORDER BY t",
  "Metric points per worker":
    "SELECT blob3 AS worker, sum(_sample_interval) AS points, count() AS stored FROM iterate_metrics WHERE timestamp > NOW() - INTERVAL '{hours}' HOUR GROUP BY worker ORDER BY points DESC LIMIT 20",
};

const Hours = z.number().int().min(1).max(168);
/** Analytics Engine's `FORMAT JSON` answer: a UInt64 comes as a string, a Float64 as a number. */
const AnalyticsEngineAnswer = z.object({
  data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
});
type Row = z.infer<typeof AnalyticsEngineAnswer>["data"][number];

/** Every panel's rows, or null without a metrics token, for a platform admin alone: this browser's
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
    return Promise.all(
      Object.entries(PANELS).map(async ([title, sql]) => {
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
      }),
    );
  });

export const Route = createFileRoute("/_auth/telemetry")({
  validateSearch: z.object({ hours: Hours.default(1).catch(1) }),
  loaderDeps: ({ search }) => ({ hours: search.hours }),
  loader: ({ deps }) => readPanels({ data: deps.hours }),
  head: () => ({ meta: [{ title: "Telemetry · Admin" }] }),
  component: TelemetryPage,
});

function TelemetryPage() {
  const panels = Route.useLoaderData();
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
      {panels ? (
        Object.keys(PANELS).map((title, index) => (
          <section key={title} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{title}</h2>
            <Panel rows={panels[index]!} hours={hours} />
          </section>
        ))
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
 *  across the range up to now, from 0 to the highest value. Each line's newest point is a dot, so a
 *  line of one point shows; hovering a bucket names its values. */
function Panel({ rows, hours }: { rows: Row[]; hours: number }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No points.</p>;
  const columns = Object.keys(rows[0]!);
  if (!columns.includes("t"))
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
  const names = columns.filter((column) => column !== "t");
  const max = Math.max(...rows.flatMap((row) => names.map((name) => Number(row[name])))) || 1;
  const now = Date.now();
  const x = (row: Row) =>
    600 - ((now - Date.parse(`${String(row.t).replace(" ", "T")}Z`)) / (hours * 3_600_000)) * 600;
  const y = (value: Row[string]) => 150 - (Number(value) / max) * 150;
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex gap-4 text-xs text-muted-foreground">
        {names.map((name, index) => (
          <span key={name}>
            <span style={{ color: COLORS[index] }}>●</span> {name}
          </span>
        ))}
        <span className="ml-auto">max {format(max)}</span>
      </figcaption>
      <svg viewBox="-10 -5 620 160" className="w-full">
        <line x1={0} x2={600} y1={150} y2={150} stroke="currentColor" opacity={0.2} />
        {names.map((name, index) => (
          <g key={name} stroke={COLORS[index]} fill={COLORS[index]}>
            <polyline
              points={rows.map((row) => `${x(row)},${y(row[name])}`).join(" ")}
              fill="none"
              strokeWidth={2}
            />
            <circle cx={x(rows.at(-1)!)} cy={y(rows.at(-1)![name])} r={4} />
          </g>
        ))}
        {rows.map((row) => (
          <rect key={String(row.t)} x={x(row) - 5} width={10} height={150} fill="transparent">
            <title>{`${row.t} UTC · ${names.map((name) => `${name} ${format(row[name])}`).join(" · ")}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}

function format(value: Row[string]) {
  return typeof value === "number"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : String(value || "");
}
