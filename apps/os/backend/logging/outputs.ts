import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { formatJsonLogEvent, formatPrettyLogEvent } from "./formatters.ts";
import type { WideLog } from "./types.ts";

export async function appendDevLogFile(log: WideLog): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = join(tmpdir(), "iterate-os-logs", `${date}.ndjson`);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${formatJsonLogEvent(log)}\n`, "utf8");
}

export function writePrettyLog(log: WideLog): void {
  process.stderr.write(`${formatPrettyLogEvent(log)}\n`);
}

export function writeJsonLog(log: WideLog): void {
  process.stdout.write(`${formatJsonLogEvent(log)}\n`);
}
