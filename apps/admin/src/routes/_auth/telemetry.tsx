// /telemetry — the platform's live metrics from Analytics Engine (docs/telemetry.md "Reading"): the
// panels of telemetry-panels.ts over the range the URL names, read in the app's Worker with its
// metrics token (APP_CONFIG `metrics`).
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { PANELS, RANGES, TelemetryRange } from "../../telemetry-panels.ts";

const Cell = z.union([z.string(), z.number(), z.null()]);
type Row = Record<string, z.infer<typeof Cell>>;
/** Analytics Engine's `FORMAT JSON` answer: a UInt64 comes as a string, a Float64 as a number. */
const AnalyticsEngineAnswer = z.object({ data: z.array(z.record(z.string(), Cell)) });

/** Every panel's rows over `range`, for a platform admin alone: this browser's session at the
 *  deployment's own issuer holds the `admin` scope, which that issuer grants to its `admins` only
 *  (apps/os consent.ts). A session connected to another issuer could hold any scope it likes. */
const readPanels = createServerFn({ method: "GET" })
  .inputValidator(TelemetryRange)
  .handler(async ({ data: range }) => {
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
    if (!config.metrics)
      return { missing: "This deployment reads no metrics (envs.ts telemetryEnvs)." };
    const { accountId, dataset, apiToken } = config.metrics;
    if (!apiToken) return { missing: "APP_CONFIG_METRICS__API_TOKEN is not set (Doppler)." };
    const panels = await Promise.all(
      PANELS.map(async (panel) => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiToken}` },
            body: `${panel.sql(dataset, RANGES[range])} FORMAT JSON`,
          },
        );
        if (!response.ok)
          throw new Error(
            `Analytics Engine answered ${panel.title} with ${response.status}: ${(await response.text()).slice(0, 300)}`,
          );
        return AnalyticsEngineAnswer.parse(await response.json()).data;
      }),
    );
    return { panels };
  });

export const Route = createFileRoute("/_auth/telemetry")({
  validateSearch: z.object({ range: TelemetryRange.default("1h").catch("1h") }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ deps }) => readPanels({ data: deps.range }),
  head: () => ({ meta: [{ title: "Telemetry · Admin" }] }),
  component: TelemetryPage,
});

function TelemetryPage() {
  const answer = Route.useLoaderData();
  const { range } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Telemetry</h1>
        <NativeSelect
          aria-label="Time range"
          value={range}
          onChange={(event) =>
            void navigate({ search: { range: TelemetryRange.parse(event.target.value) } })
          }
        >
          {TelemetryRange.options.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {RANGES[option].label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {"missing" in answer ? (
        <p className="text-sm text-muted-foreground">{answer.missing}</p>
      ) : (
        PANELS.map((panel, index) => (
          <section key={panel.title} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{panel.title}</h2>
            {answer.panels[index]!.length === 0 ? (
              <p className="text-sm text-muted-foreground">No points in this range.</p>
            ) : panel.chart === "series" ? (
              <SeriesChart rows={answer.panels[index]!} />
            ) : (
              <RowsTable rows={answer.panels[index]!} />
            )}
          </section>
        ))
      )}
    </div>
  );
}

/** Categorical slots 1 and 2 of the validated default data-viz palette, light mode. */
const SERIES_COLORS = ["#2a78d6", "#eb6834"];
const WIDTH = 600;
const HEIGHT = 160;

/** A series panel's lines over its buckets `t` ("2026-09-30 13:00:00", UTC), one per other column,
 *  from 0 to the highest value; hovering a bucket names its values. */
function SeriesChart({ rows }: { rows: Row[] }) {
  const names = Object.keys(rows[0]!).filter((column) => column !== "t");
  const times = rows.map((row) => Date.parse(`${String(row.t).replace(" ", "T")}Z`));
  const first = times[0]!;
  const span = times.at(-1)! - first || 1;
  const max = Math.max(...rows.flatMap((row) => names.map((name) => Number(row[name]))), 1);
  const x = (index: number) => ((times[index]! - first) / span) * WIDTH;
  return (
    <figure className="flex flex-col gap-1">
      <div className="flex gap-4 text-xs text-muted-foreground">
        {names.map((name, index) => (
          <span key={name} className="flex items-center gap-1.5">
            <span className="h-0.5 w-3" style={{ background: SERIES_COLORS[index] }} />
            {name}
          </span>
        ))}
        <span className="ml-auto">max {format(max)}</span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="h-40 w-full">
        <line x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke="currentColor" opacity={0.2} />
        {names.map((name, index) => (
          <polyline
            key={name}
            points={rows
              .map((row, at) => `${x(at)},${HEIGHT - (Number(row[name]) / max) * HEIGHT}`)
              .join(" ")}
            fill="none"
            stroke={SERIES_COLORS[index]}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {rows.map((row, at) => (
          <rect
            key={at}
            x={x(at) - WIDTH / rows.length / 2}
            width={WIDTH / rows.length}
            height={HEIGHT}
            fill="transparent"
          >
            <title>{`${row.t} UTC · ${names.map((name) => `${name} ${format(row[name])}`).join(" · ")}`}</title>
          </rect>
        ))}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{rows[0]!.t} UTC</span>
        <span>{rows.at(-1)!.t} UTC</span>
      </div>
    </figure>
  );
}

function RowsTable({ rows }: { rows: Row[] }) {
  const columns = Object.keys(rows[0]!);
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          {columns.map((column) => (
            <th key={column} className="py-1 font-medium">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-t">
            {columns.map((column) => (
              <td key={column} className="py-1.5 font-mono text-xs">
                {format(row[column])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function format(value: unknown) {
  return typeof value === "number"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : String(value ?? "");
}
