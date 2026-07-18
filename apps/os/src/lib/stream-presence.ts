// Presence + real browser-measured metrics helpers shared by the stream
// header chrome and the processors panel.

import { useMemo, useSyncExternalStore } from "react";
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

type BrowserStreamMetricsSource = {
  metrics(): BrowserStreamMetrics;
  subscribeMetrics(listener: () => void): () => void;
};

/**
 * Adapt the browser runtime's stable metrics snapshot to the view shape. The
 * source publishes only when a producer records a measurement; unrelated
 * runtime notifications are ignored by snapshot identity. Keeping the
 * sparkline here leaves its presentation-sized history out of the runtime.
 */
export function createBrowserStreamMetricsViewStore(source: BrowserStreamMetricsSource): {
  getSnapshot(): BrowserStreamMetricsView;
  subscribe(listener: () => void): () => void;
} {
  let sourceSnapshot = source.metrics();
  let lastSampleAt = 0;
  let spark: number[] = [];

  const buildSnapshot = (metrics: BrowserStreamMetrics): BrowserStreamMetricsView => {
    const rtt = metrics.transportRttMs;
    if (rtt !== null && rtt.lastAt !== lastSampleAt) {
      lastSampleAt = rtt.lastAt;
      spark = [...spark.slice(-(SPARK_LENGTH - 1)), rtt.last];
    }
    return { ...metrics, spark };
  };
  let viewSnapshot = buildSnapshot(sourceSnapshot);

  const refresh = (): boolean => {
    const nextSourceSnapshot = source.metrics();
    if (Object.is(nextSourceSnapshot, sourceSnapshot)) return false;
    sourceSnapshot = nextSourceSnapshot;
    viewSnapshot = buildSnapshot(sourceSnapshot);
    return true;
  };

  return {
    getSnapshot: () => {
      refresh();
      return viewSnapshot;
    },
    subscribe: (listener) => {
      const unsubscribe = source.subscribeMetrics(() => {
        if (refresh()) listener();
      });
      // Close the render-to-subscribe race: a producer may have published
      // after this adapter's construction but before React committed it.
      if (refresh()) listener();
      return unsubscribe;
    },
  };
}

/** Subscribe to producer-published browser metrics; no timer or polling. */
export function useBrowserStreamMetrics(
  store: BrowserStreamMetricsSource,
): BrowserStreamMetricsView {
  const viewStore = useMemo(() => createBrowserStreamMetricsViewStore(store), [store]);
  return useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, viewStore.getSnapshot);
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
  return entry.processor?.slug ?? entry.description ?? entry.subscriptionKey;
}

export function presenceInitials(label: string): string {
  const segments = label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return "??";
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
