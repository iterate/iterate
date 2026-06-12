// Presence + (simulated) metrics helpers shared by the stream header chrome
// and the processors panel.

import { useEffect, useMemo, useState } from "react";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-processor/contract";

// ---------------------------------------------------------------------------
// Simulated round-trip metrics (per design — real data comes later)
// ---------------------------------------------------------------------------

export type RttMetrics = {
  spark: number[];
  rttNow: number;
  p50: number;
  p95: number;
};

const INITIAL_SPARK = [
  42, 38, 51, 36, 44, 39, 35, 62, 41, 38, 36, 55, 40, 37, 43, 39, 112, 48, 38, 36, 41, 39, 37, 38,
];

/** Random-walk append RTT with the occasional spike, ticking every ~2.2s. */
export function useSimulatedRttMetrics(): RttMetrics {
  const [spark, setSpark] = useState<number[]>(INITIAL_SPARK);

  useEffect(() => {
    const timer = setInterval(() => {
      setSpark((previous) => {
        const next = previous.slice(1);
        const value =
          Math.random() > 0.93
            ? Math.round(120 + Math.random() * 160)
            : Math.round(30 + Math.random() * 30);
        next.push(value);
        return next;
      });
    }, 2200);
    return () => clearInterval(timer);
  }, []);

  return useMemo(() => {
    const sorted = [...spark].sort((a, b) => a - b);
    return {
      spark,
      rttNow: spark[spark.length - 1] ?? 0,
      p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    };
  }, [spark]);
}

export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  const max = 400;
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
