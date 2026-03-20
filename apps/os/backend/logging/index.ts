/*
 * Inspired by loggingsucks.com and evlog.dev.
 * apps/os uses one wide event per request/task.
 */

export { logger } from "./logger.ts";
export { clearBufferedLogEvents, getBufferedLogEvents, recordBufferedLog } from "./buffer.ts";
export { appendDevLogFile, writeJsonLog, writePrettyLog } from "./outputs.ts";
export { shouldKeepLogEvent } from "./filter.ts";
export { formatJsonLogEvent, formatPrettyLogEvent } from "./formatters.ts";
export { wrapWaitUntilWithLogging } from "./wait-until.ts";
