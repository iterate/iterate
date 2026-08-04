const traceWindowNames = ["onset", "settled", "tail"] as const;

export type AecReleaseTraceWindowName = (typeof traceWindowNames)[number];

/**
 * Places bounded device-owned captures at deterministic release-matrix times.
 *
 * A trace is intentionally too small to retain every realtime sample. The
 * schedule therefore belongs to the shared evidence contract, not a target
 * adapter: otherwise one target can quietly call a convenient interval
 * "settled" while the other captures onset or misses the deliberate outage.
 */
export function aecReleaseTraceOffsets(
  phaseDurationMs: number,
  traceDurationMs: number,
  phaseId?: string,
) {
  if (!Number.isFinite(traceDurationMs) || traceDurationMs <= 0) {
    throw new Error("AEC release trace has an invalid duration.");
  }
  if (phaseDurationMs <= traceDurationMs + 250) return [0];
  const candidates =
    phaseId === "lifecycle-playback-underrun-recovery"
      ? [0, Math.max(0, 5_000 - Math.floor(traceDurationMs / 2)), phaseDurationMs - traceDurationMs]
      : [0, Math.floor((phaseDurationMs - traceDurationMs) / 2), phaseDurationMs - traceDurationMs];
  const offsets: number[] = [];
  for (const candidate of candidates) {
    if (offsets.length === 0 || candidate - offsets.at(-1)! >= traceDurationMs) {
      offsets.push(candidate);
    }
  }
  return offsets;
}

export function aecReleaseTraceWindowName(index: number, count: number) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count) {
    throw new Error("AEC release trace window index is outside its schedule.");
  }
  return index === 0 ? "onset" : index === count - 1 ? "tail" : "settled";
}
