import "uplot/dist/uPlot.min.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import uPlot from "uplot";
import UplotReact from "uplot-react";
import { trpc } from "../lib/trpc.tsx";
import { Spinner } from "./ui/spinner.tsx";

const CHART_HEIGHT = 220;
const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

type PrometheusMetric = Record<string, string>;
type PrometheusMatrixResult = {
  metric: PrometheusMetric;
  values: Array<[number, string]>;
};

type PrometheusUplotChartProps = {
  title: string;
  projectSlug: string;
  machineId: string;
  query: string;
  yAxisLabel: string;
  noDataMessage: string;
  getSeriesLabel?: (metric: PrometheusMetric, index: number) => string;
  formatValue?: (value: number) => string;
};

function defaultFormatValue(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function toMatrixSeries(input: unknown): PrometheusMatrixResult[] {
  if (!input || typeof input !== "object") return [];
  const payload = input as {
    status?: string;
    data?: { resultType?: string; result?: unknown };
  };
  if (payload.status !== "success") return [];
  if (!payload.data || payload.data.resultType !== "matrix") return [];
  if (!Array.isArray(payload.data.result)) return [];

  return payload.data.result.filter((entry): entry is PrometheusMatrixResult => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as { metric?: unknown; values?: unknown };
    return Boolean(candidate.metric && Array.isArray(candidate.values));
  });
}

function buildAlignedData(series: PrometheusMatrixResult[]): uPlot.AlignedData | null {
  if (series.length === 0) return null;

  const allTimestamps = Array.from(
    new Set(series.flatMap((s) => s.values.map(([timestamp]) => timestamp))),
  ).sort((a, b) => a - b);
  if (allTimestamps.length === 0) return null;

  const seriesData = series.map((item) => {
    const valueByTimestamp = new Map<number, number>();
    item.values.forEach(([timestamp, rawValue]) => {
      const numericValue = Number(rawValue);
      if (Number.isFinite(numericValue)) {
        valueByTimestamp.set(timestamp, numericValue);
      }
    });
    return allTimestamps.map((timestamp) => valueByTimestamp.get(timestamp) ?? null);
  });

  return [allTimestamps, ...seriesData] as uPlot.AlignedData;
}

export function PrometheusUplotChart({
  title,
  projectSlug,
  machineId,
  query,
  yAxisLabel,
  noDataMessage,
  getSeriesLabel,
  formatValue = defaultFormatValue,
}: PrometheusUplotChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(320);

  const { data, isPending, isError, error } = useQuery(
    trpc.metrics.queryRange.queryOptions(
      {
        projectSlug,
        machineId,
        query,
      },
      {
        refetchInterval: 30_000,
        retry: 1,
      },
    ),
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const nextWidth = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (nextWidth > 0) setChartWidth(nextWidth);
    });

    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const matrixSeries = useMemo(() => toMatrixSeries(data), [data]);
  const alignedData = useMemo(() => buildAlignedData(matrixSeries), [matrixSeries]);

  const options = useMemo<uPlot.Options | null>(() => {
    if (!alignedData) return null;

    return {
      width: Math.max(280, chartWidth),
      height: CHART_HEIGHT,
      series: [
        {},
        ...matrixSeries.map((series, index) => ({
          label:
            getSeriesLabel?.(series.metric, index) ??
            series.metric.groupname ??
            `Series ${index + 1}`,
          stroke: CHART_COLORS[index % CHART_COLORS.length],
          width: 2,
          points: { show: false },
          value: (_u: uPlot, value: number | null) => (value == null ? "-" : formatValue(value)),
        })),
      ],
      axes: [
        {},
        {
          label: yAxisLabel,
          values: (_u: uPlot, values: number[]) => values.map((value) => formatValue(value)),
        },
      ],
      legend: {
        show: true,
      },
      scales: {
        x: {
          time: true,
        },
      },
    };
  }, [alignedData, chartWidth, matrixSeries, getSeriesLabel, formatValue, yAxisLabel]);

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div ref={containerRef}>
        {isPending && (
          <div className="flex h-[220px] items-center justify-center text-muted-foreground">
            <Spinner className="h-4 w-4" />
          </div>
        )}
        {!isPending && isError && (
          <div className="flex h-[220px] items-center justify-center px-2 text-center text-xs text-muted-foreground">
            {error instanceof Error ? error.message : "Failed to load metrics"}
          </div>
        )}
        {!isPending && !isError && (!alignedData || !options) && (
          <div className="flex h-[220px] items-center justify-center px-2 text-center text-xs text-muted-foreground">
            {noDataMessage}
          </div>
        )}
        {!isPending && !isError && alignedData && options && (
          <UplotReact options={options} data={alignedData} />
        )}
      </div>
    </section>
  );
}
