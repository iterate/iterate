import type { WideLog } from "./types.ts";

const MAX_BUFFERED_LOGS = 1000;
const bufferedLogs: WideLog[] = [];

export function recordBufferedLog(log: WideLog): void {
  bufferedLogs.push(structuredClone(log));
  if (bufferedLogs.length > MAX_BUFFERED_LOGS) {
    bufferedLogs.splice(0, bufferedLogs.length - MAX_BUFFERED_LOGS);
  }
}

export function getBufferedLogEvents(): WideLog[] {
  return structuredClone(bufferedLogs);
}

export function clearBufferedLogEvents(): void {
  bufferedLogs.length = 0;
}
