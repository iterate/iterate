import { inspect } from "node:util";

const serviceName = "meta-mcp-service";

function formatMeta(meta: Record<string, unknown>) {
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }

  return ` ${inspect(Object.fromEntries(entries), { breakLength: Infinity, depth: 5, compact: true })}`;
}

export function logInfo(message: string, meta: Record<string, unknown> = {}) {
  console.info(`[${serviceName}] ${message}${formatMeta(meta)}`);
}

export function logWarn(message: string, meta: Record<string, unknown> = {}) {
  console.warn(`[${serviceName}] ${message}${formatMeta(meta)}`);
}

export function logError(message: string, meta: Record<string, unknown> = {}) {
  console.error(`[${serviceName}] ${message}${formatMeta(meta)}`);
}

export const logger = {
  info: logInfo,
  warn: logWarn,
  error: logError,
};
