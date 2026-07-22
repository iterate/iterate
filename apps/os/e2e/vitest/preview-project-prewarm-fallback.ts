/** Write complete non-gating telemetry after the outer shell watchdog wins. */
import { fileURLToPath } from "node:url";
import { writePreviewProjectPrewarmTelemetry } from "./preview-project-prewarm-telemetry.ts";

const exitCode = integerArgument(2, "exit code");
const durationSeconds = integerArgument(3, "duration seconds");
const state = exitCode === 124 || exitCode === 137 ? "timedout" : "failed";
const error = {
  name: "PreviewProjectPrewarmOuterFailureError",
  message: `Outer preview project prewarm process exited ${exitCode} after ${durationSeconds}s before writing completed telemetry.`,
};
const { durationMs } = writePreviewProjectPrewarmTelemetry({
  error,
  exitCode,
  moduleId: fileURLToPath(import.meta.url),
  phases: [],
  runStartedAt: Date.now() - durationSeconds * 1_000,
  state,
});

console.warn(`[preview-project-prewarm] recorded outer ${state} after ${durationMs}ms`, error);

function integerArgument(index: number, label: string) {
  const raw = process.argv[index];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`Preview project prewarm fallback requires a non-negative ${label}.`);
  }
  return parsed;
}
