import { appendFileSync } from "node:fs";
import { format } from "node:util";

const colors = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
} as const;

const levelColors = {
  debug: colors.gray,
  info: colors.green,
  warn: colors.yellow,
  error: colors.red,
} as const;

const formatTime = (date: Date) =>
  Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).format(date);

const formatPrefixNoColor = (level: string, name: string, time: Date) => {
  const levelFormatted = level.toUpperCase().padStart(5);
  const timestamp = formatTime(time);
  return `[${timestamp}] ${levelFormatted} (${name})`;
};

const formatPrefixWithColor = (level: string, name: string, time: Date) => {
  const levelFormatted = level.toUpperCase().padStart(5);
  const timestamp = formatTime(time);
  const levelTint = levelColors[level as keyof typeof levelColors] ?? "";
  return `${colors.gray}[${timestamp}]${colors.reset} ${levelTint}${levelFormatted}${colors.reset} (${name})`;
};

type LoggerConfig = {
  name: string;
  stdout?: boolean;
  logFile?: string;
  prefix?: string;
};

const formatMessagePrefix = (prefix: string | undefined, colored: boolean) => {
  if (!prefix) return "";
  if (colored) return `${colors.bold}${colors.white}[${prefix}]${colors.reset} `;
  return `[${prefix}]`;
};

const logLine = (config: LoggerConfig, level: "debug" | "info" | "warn" | "error", args: any[]) => {
  const message = format(...args);
  const time = new Date();

  if (config.logFile) {
    const plainPrefix = formatPrefixNoColor(level, config.name, time);
    const plainMessagePrefix = formatMessagePrefix(config.prefix, false);
    const plainLine = [plainPrefix, plainMessagePrefix, message].filter(Boolean).join(" ");
    try {
      appendFileSync(config.logFile, `${plainLine}\n`);
    } catch {
      // Ignore errors
    }
  }

  if (config.stdout) {
    const coloredPrefix = formatPrefixWithColor(level, config.name, time);
    const coloredMessagePrefix = formatMessagePrefix(config.prefix, true);
    const coloredLine = [coloredPrefix, coloredMessagePrefix, message].filter(Boolean).join(" ");
    console[level](coloredLine);
  }
};

export const logger = (_config: LoggerConfig) => {
  const config = { stdout: true, ..._config };
  return {
    info: (...args: any[]) => logLine(config, "info", args),
    error: (...args: any[]) => logLine(config, "error", args),
    warn: (...args: any[]) => logLine(config, "warn", args),
    debug: (...args: any[]) => logLine(config, "debug", args),
    child: (suffix: string, overrides: Partial<Omit<LoggerConfig, "name">> = {}) =>
      logger({
        ...config,
        ...overrides,
        name: `${config.name}:${suffix}`,
      }),
    withPrefix: (prefix: string) =>
      logger({
        ...config,
        prefix,
      }),
  };
};

export type Logger = ReturnType<typeof logger>;
