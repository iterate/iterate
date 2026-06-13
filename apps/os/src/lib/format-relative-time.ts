/** Coarse "3 days ago" / "in 2 hours" relative time, shared by list views. */
export function formatRelativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
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
