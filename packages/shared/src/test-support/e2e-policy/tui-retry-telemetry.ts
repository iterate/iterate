export type TuiRetryTelemetry = {
  retried: Array<{
    fullName: string;
    retryCount: number;
    passedAfterRetry: boolean;
  }>;
};

/** Parse Microsoft TUI Test's list reporter into the shared retry JSON shape. */
export function parseTuiRetryTelemetry(output: string): TuiRetryTelemetry {
  const retried = new Map<string, TuiRetryTelemetry["retried"][number]>();

  for (const line of output.split("\n")) {
    const retry = line.match(/\(retry #(\d+)\)/);
    if (retry == null) continue;

    const prefix = line.slice(0, retry.index).trimEnd();
    const fullName = prefix.replace(/^\s*\S+\s+\d+\s+/u, "").trim();
    if (fullName === "") continue;

    const record = {
      fullName,
      retryCount: Number(retry[1]),
      passedAfterRetry: prefix.trimStart().startsWith("✔"),
    };
    const previous = retried.get(fullName);
    if (previous == null || record.retryCount >= previous.retryCount) {
      retried.set(fullName, record);
    }
  }

  return { retried: [...retried.values()] };
}
