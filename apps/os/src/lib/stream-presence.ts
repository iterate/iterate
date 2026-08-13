// Presence + real browser-measured metrics helpers shared by the stream
// header chrome and the processors panel.

import { useEffect, useState } from "react";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { BrowserStreamMetrics } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";

// ---------------------------------------------------------------------------
// Real browser-measured metrics (see stream-browser-store.metrics())
// ---------------------------------------------------------------------------

/**
 * What the header sparkline and the processors panel render for THIS
 * browser: measured transport RTT samples (spark accumulates the ring's new
 * samples over time) plus the hosted processor's self-measured consumption
 * report. Every value traces to a real measurement; `spark` is empty and
 * stats are null until samples exist.
 */
export type BrowserStreamMetricsView = BrowserStreamMetrics & {
  spark: number[];
};

const SPARK_LENGTH = 24;
const METRICS_POLL_MS = 1_000;

/** Poll the store's measured metrics and accumulate the RTT sparkline. */
export function useBrowserStreamMetrics(store: {
  metrics(): BrowserStreamMetrics;
}): BrowserStreamMetricsView {
  const [view, setView] = useState<BrowserStreamMetricsView>({
    spark: [],
    transportRttMs: null,
    eventConsumption: undefined,
  });

  useEffect(() => {
    let spark: number[] = [];
    let lastSampleAt = 0;
    let lastSerialized = "";
    const tick = () => {
      const current = store.metrics();
      const rtt = current.transportRttMs;
      if (rtt && rtt.lastAt !== lastSampleAt) {
        lastSampleAt = rtt.lastAt;
        spark = [...spark.slice(-(SPARK_LENGTH - 1)), rtt.last];
      }
      // Change-gated: ticks without a new sample (a quiet stream between
      // probes) must not rerender the whole stream view every second.
      const next = { ...current, spark };
      const serialized = JSON.stringify(next);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      setView(next);
    };
    tick();
    const timer = setInterval(tick, METRICS_POLL_MS);
    return () => clearInterval(timer);
  }, [store]);

  return view;
}

export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  opts: {
    /** Shared scale for multi-series graphs; defaults to this series' own max, floored at 100 (RTT jitter shouldn't render as drama). */
    max?: number;
  } = {},
): string {
  const max = opts.max ?? Math.max(100, ...values);
  const count = values.length;
  if (count === 0) return "";
  return values
    .map((value, index) => {
      const x = 2 + index * ((width - 4) / Math.max(1, count - 1));
      const y = height - 4 - (Math.min(value, max) / max) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Presence avatars
// ---------------------------------------------------------------------------

const AVATAR_PALETTE = [
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
];

export function presenceLabel(entry: AgentUiPresenceEntry): string {
  return (
    entry.user?.name ??
    entry.user?.email ??
    entry.processor?.slug ??
    entry.description ??
    entry.connectionKey
  );
}

export function presenceInitials(label: string): string {
  const segments = label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!segments.length) return "??";
  if (segments.length === 1) return segments[0]!.slice(0, 2).toUpperCase();
  return `${segments[0]![0]}${segments[1]![0]}`.toUpperCase();
}

export function presenceColorClasses(label: string): string {
  return AVATAR_PALETTE[hashString(label) % AVATAR_PALETTE.length]!;
}

export function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
