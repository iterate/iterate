/**
 * Relative time for a timestamp that records something that HAPPENED — clock
 * skew between the server that stamped it and the browser (plus a caller's
 * coarse clock tick) can put it a few seconds "in the future", and a past
 * event must never read "in a few seconds". The delta is clamped at zero:
 * skewed-fresh is "just now".
 */
export function formatTimeAgo(value: string, nowMs: number = Date.now()) {
  return formatRelativeTime(value, Math.max(nowMs, new Date(value).getTime()));
}

/**
 * Coarse "3 days ago" / "in 2 hours" relative time, shared by list views.
 * For timestamps of PAST events use {@link formatTimeAgo} instead — it clamps
 * server↔browser clock skew; this two-sided form is for values that are
 * legitimately in the future (the scheduler's next trigger).
 * Pass `nowMs` when the caller re-renders on its own clock tick (a live list),
 * so the label is a pure function of its inputs instead of reading the clock
 * mid-render.
 */
export function formatRelativeTime(value: string, nowMs: number = Date.now()) {
  const seconds = Math.round((nowMs - new Date(value).getTime()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units = [
    { label: "year", seconds: 31_536_000 },
    { label: "month", seconds: 2_592_000 },
    { label: "day", seconds: 86_400 },
    { label: "hour", seconds: 3_600 },
    { label: "minute", seconds: 60 },
  ] as const;
  const unit = units.find((unit) => absoluteSeconds >= unit.seconds);
  if (!unit) return seconds < 0 ? "in a few seconds" : "just now";

  const count = Math.round(absoluteSeconds / unit.seconds);
  const suffix = count === 1 ? unit.label : `${unit.label}s`;
  return seconds < 0 ? `in ${count} ${suffix}` : `${count} ${suffix} ago`;
}
