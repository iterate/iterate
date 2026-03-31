import type { DrainContext, WideEvent } from "evlog";

export type RequestLogEntry = {
  level?: string;
  message?: string;
  timestamp?: string;
};

export type AppStdoutEvent = WideEvent & {
  appName?: string;
  requestLogs?: RequestLogEntry[];
};

type ConsoleMethod = (...args: unknown[]) => void;

const ansi = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  magenta: "\u001B[35m",
} as const;

const evlogConsoleFilterKey = Symbol.for("iterate.evlog.console-filter-installed");

function levelColor(level: string | undefined) {
  if (level === "error") return ansi.red;
  if (level === "warn") return ansi.yellow;
  if (level === "debug") return ansi.magenta;
  return ansi.green;
}

function formatClockTime(timestamp: unknown) {
  if (typeof timestamp !== "string" || timestamp.length < 23) {
    return "??:??:??.???";
  }

  return timestamp.slice(11, 23);
}

/** Renders a wall-clock duration: sub-second as rounded ms, otherwise seconds with two decimals. */
export function formatCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function resolveDurationMs(event: AppStdoutEvent): number | undefined {
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
    return event.durationMs;
  }

  if (typeof event.duration === "string") {
    const trimmed = event.duration.trim();
    const msMatch = /^(\d+)ms$/.exec(trimmed);
    if (msMatch) {
      return Number(msMatch[1]);
    }

    const sMatch = /^(\d+(?:\.\d+)?)s$/.exec(trimmed);
    if (sMatch) {
      return Number(sMatch[1]) * 1000;
    }
  }

  return undefined;
}

function formatDeltaBetweenTimestamps(
  previousTimestamp: string | undefined,
  currentTimestamp: string | undefined,
) {
  if (!previousTimestamp || !currentTimestamp) {
    return "+0ms";
  }

  const previousMs = Date.parse(previousTimestamp);
  const currentMs = Date.parse(currentTimestamp);

  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) {
    return "+0ms";
  }

  const delta = Math.max(0, currentMs - previousMs);
  return `+${formatCompactDuration(delta)}`;
}

function formatInlineValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatInlineValue(item)).join(", ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, nestedValue]) => {
        const serialized =
          typeof nestedValue === "object" && nestedValue !== null
            ? JSON.stringify(nestedValue)
            : formatInlineValue(nestedValue);

        return `${key}=${serialized}`;
      })
      .join(" ");
  }

  return String(value);
}

function formatStructuredLines(options: {
  label?: string;
  value: unknown;
  indent: number;
}): string[] {
  const prefix = " ".repeat(options.indent);

  if (options.value === null || options.value === undefined) {
    return options.label ? [`${prefix}${options.label}: ${formatInlineValue(options.value)}`] : [];
  }

  if (typeof options.value !== "object" || Array.isArray(options.value)) {
    return options.label ? [`${prefix}${options.label}: ${formatInlineValue(options.value)}`] : [];
  }

  const entries = Object.entries(options.value);
  if (entries.length === 0) {
    return options.label ? [`${prefix}${options.label}: {}`] : [];
  }

  const lines = options.label ? [`${prefix}${options.label}:`] : [];
  for (const [key, nestedValue] of entries) {
    if (nestedValue === undefined) {
      continue;
    }

    if (
      nestedValue !== null &&
      typeof nestedValue === "object" &&
      !Array.isArray(nestedValue) &&
      Object.keys(nestedValue).length > 0
    ) {
      lines.push(
        ...formatStructuredLines({ label: key, value: nestedValue, indent: options.indent + 2 }),
      );
      continue;
    }

    lines.push(`${" ".repeat(options.indent + 2)}${key}: ${formatInlineValue(nestedValue)}`);
  }

  return lines;
}

function formatErrorValue(value: unknown) {
  if (!value || typeof value !== "object") {
    return formatInlineValue(value);
  }

  const name = "name" in value && typeof value.name === "string" ? value.name : "Error";
  const message = "message" in value && typeof value.message === "string" ? value.message : "";

  return message ? `${name}: ${message}` : name;
}

function createBodyEntries(event: AppStdoutEvent) {
  const entries: string[] = [];

  if (event.rpc && typeof event.rpc === "object") {
    entries.push(`${ansi.cyan}rpc:${ansi.reset} ${formatInlineValue(event.rpc)}`);
  }

  if (event.error !== undefined) {
    entries.push(`${ansi.cyan}error:${ansi.reset} ${formatErrorValue(event.error)}`);
  }

  const topLevelExcludedKeys = new Set([
    "timestamp",
    "level",
    "appName",
    "environment",
    "version",
    "commitHash",
    "region",
    "method",
    "path",
    "status",
    "duration",
    "durationMs",
    "message",
    "requestLogs",
    "error",
    "rpc",
    "requestId",
    "app",
    "config",
    "cfRay",
    "traceparent",
    "colo",
    "country",
    "asn",
  ]);

  for (const [key, value] of Object.entries(event)) {
    if (topLevelExcludedKeys.has(key) || value === undefined) {
      continue;
    }

    entries.push(...formatStructuredLines({ label: key, value, indent: 0 }));
  }

  if (Array.isArray(event.requestLogs) && event.requestLogs.length > 0) {
    const logs = event.requestLogs;
    const endTimestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    const totalDurationMs = resolveDurationMs(event);

    const deltas: string[] = [];
    let previousTimestamp: string | undefined;
    for (const requestLog of logs) {
      deltas.push(formatDeltaBetweenTimestamps(previousTimestamp, requestLog.timestamp));
      previousTimestamp = requestLog.timestamp;
    }

    const lastLog = logs[logs.length - 1];
    const lastLogTs =
      lastLog && typeof lastLog.timestamp === "string" ? lastLog.timestamp : undefined;

    if (endTimestamp !== undefined && totalDurationMs !== undefined && lastLogTs !== undefined) {
      deltas.push(formatDeltaBetweenTimestamps(lastLogTs, endTimestamp));
    }

    const maxDeltaWidth = Math.max(0, ...deltas.map((delta) => delta.length));

    for (const [index, requestLog] of logs.entries()) {
      const delta = deltas[index] ?? "+0ms";
      const level = typeof requestLog.level === "string" ? requestLog.level : "info";
      const message = typeof requestLog.message === "string" ? requestLog.message : "";
      const color = levelColor(level);
      entries.push(
        `${ansi.dim}${delta.padEnd(maxDeltaWidth)}${ansi.reset} ${color}${level
          .toUpperCase()
          .padEnd(5)}${ansi.reset} ${message}`,
      );
    }

    if (endTimestamp !== undefined && totalDurationMs !== undefined && lastLogTs !== undefined) {
      const syntheticDelta = deltas[logs.length] ?? "+0ms";
      const endedMessage = `Request ended at ${formatClockTime(endTimestamp)} after ${formatCompactDuration(totalDurationMs)}`;
      entries.push(
        `${ansi.dim}${syntheticDelta.padEnd(maxDeltaWidth)}${ansi.reset} ${ansi.dim}${"INFO"
          .toUpperCase()
          .padEnd(5)}${ansi.reset} ${ansi.dim}${endedMessage}${ansi.reset}`,
      );
    }
  }

  return entries;
}

export function renderPrettyStdoutEvent(event: AppStdoutEvent) {
  const level = typeof event.level === "string" ? event.level : "info";
  const color = levelColor(level);
  const headerParts = [
    `${ansi.dim}${formatClockTime(event.timestamp)}${ansi.reset}`,
    `${color}${level.toUpperCase()}${ansi.reset}`,
    `${ansi.cyan}[${typeof event.appName === "string" ? event.appName : "app"}]${ansi.reset}`,
  ];
  const message =
    typeof event.message === "string" && event.message.trim().length > 0
      ? event.message
      : undefined;

  if (message) {
    headerParts.push(message);
  } else {
    if (typeof event.method === "string" && typeof event.path === "string") {
      headerParts.push(`${event.method} ${event.path}`);
    }

    if (typeof event.status === "number") {
      headerParts.push(`${event.status}`);
    }

    const totalDurationMs = resolveDurationMs(event);
    if (totalDurationMs !== undefined) {
      headerParts.push(`in ${formatCompactDuration(totalDurationMs)}`);
    } else if (typeof event.duration === "string") {
      headerParts.push(`in ${event.duration}`);
    }
  }

  const entries = createBodyEntries(event);
  if (entries.length === 0) {
    return headerParts.join(" ");
  }

  const body = entries.map((entry, index) => {
    const marker = index === entries.length - 1 ? "└─" : "├─";
    const continuation = index === entries.length - 1 ? "   " : "│  ";
    const [firstLine, ...restLines] = entry.split("\n");
    return [
      `  ${marker} ${firstLine}`,
      ...restLines.map((line) => `  ${continuation} ${line}`),
    ].join("\n");
  });

  return `${headerParts.join(" ")}\n${body.join("\n")}`;
}

/**
 * Shared pretty stdout drain for app-style runtimes.
 *
 * evlog still owns event creation and request lifecycle timing. This drain only
 * changes how already-built wide events are rendered to stdout.
 */
export function createPrettyStdoutDrain(writer: (chunk: string) => void = writePrettyStdout) {
  return ({ event }: DrainContext) => {
    writer(renderPrettyStdoutEvent(event as AppStdoutEvent));
  };
}

export function createRawStdoutDrain(
  writer: (event: AppStdoutEvent) => void = writeRawStdoutEvent,
) {
  return ({ event }: DrainContext) => {
    writer(event as AppStdoutEvent);
  };
}

function isEvlogWideEventLike(value: unknown): value is AppStdoutEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "timestamp" in value &&
    typeof value.timestamp === "string" &&
    "level" in value &&
    typeof value.level === "string" &&
    "appName" in value &&
    typeof value.appName === "string"
  );
}

function wrapConsoleMethod(method: ConsoleMethod): ConsoleMethod {
  return (...args: unknown[]) => {
    if (args.length === 1 && isEvlogWideEventLike(args[0])) {
      return;
    }

    method(...args);
  };
}

/**
 * When we render pretty stdout ourselves, evlog still emits the wide event via
 * `console[method](event)` in raw-object mode. This filter suppresses only those
 * raw evlog event objects so the custom pretty drain becomes the sole stdout
 * representation.
 */
export function installEvlogConsoleFilter() {
  const runtime = globalThis as typeof globalThis & {
    [evlogConsoleFilterKey]?: boolean;
  };

  if (runtime[evlogConsoleFilterKey]) {
    return;
  }

  console.log = wrapConsoleMethod(console.log.bind(console));
  console.info = wrapConsoleMethod(console.info.bind(console));
  console.warn = wrapConsoleMethod(console.warn.bind(console));
  console.error = wrapConsoleMethod(console.error.bind(console));
  runtime[evlogConsoleFilterKey] = true;
}

export function writePrettyStdout(chunk: string) {
  if (typeof process !== "undefined" && process.stdout?.write) {
    process.stdout.write(`${chunk}\n`);
    return;
  }

  console.log(chunk);
}

export function writeRawStdoutEvent(event: AppStdoutEvent) {
  if (typeof process !== "undefined" && process.stdout?.write) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  console.log(event);
}
