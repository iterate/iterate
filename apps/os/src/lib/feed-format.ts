// Display formatters for the agent feed and its inspector panels: compact,
// human-scale renderings of the numbers the stream produces (token counts,
// durations, file sizes, timestamps). Pure string functions — no locale
// state, no React.

/** `950`, `2.5k` — compact token count; `?` when the model reported none. */
export function formatTokens(count: number | undefined): string {
  if (count == null) return "?";
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** `950 ms`, `2.4 s`, `1m 40s` — duration from milliseconds. */
export function formatSeconds(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** `950 B`, `1.5 KB`, `2.3 MB` — file size from bytes. */
export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const kilobytes = size / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(kilobytes / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Human bytes-per-second rate. */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 B/s";
  return `${formatFileSize(Math.round(bytesPerSecond))}/s`;
}

/** Code-mode agents stream itx code as their response; chat agents stream
 * prose. Decides whether LLM response text renders as a code block. */
const CODE_START_PATTERN = /^\s*(async|await|function|const|let|import)\b/;
export function looksLikeCode(text: string): boolean {
  return text.includes("```") || CODE_START_PATTERN.test(text);
}

/** Locale time-of-day with seconds, for step start times. */
export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Locale date + time, for row tooltips and sr-only timestamps. */
export function formatDateTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/** ISO string for `<time dateTime>`; undefined when the timestamp is invalid. */
export function formatDateTimeAttribute(timestampMs: number): string | undefined {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}
