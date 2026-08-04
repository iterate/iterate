import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectItxReady } from "iterate/node";
import {
  assessProductionAecDiagnosticCapture,
  parseProductionAecDiagnosticCapture,
} from "../src/device/production-aec-diagnostic-capture.ts";
import { isProductionPcmPlaybackTerminal } from "../src/device/production-pcm-playback-terminal.ts";
import { resolveProductionProjectApiKey } from "../src/device/production-project-api-key.ts";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
} from "../src/userspace/config-worker/provider-event-stream.ts";

const executeFile = promisify(execFile);
const projectId = "prj_0363ecd53eda492e972b07debd56eb46";
const deviceId = "stackchan";
const baseUrl = "https://os.iterate.com";
/* Reproduce the person's failed turn verbatim; a longer synthetic phrase can
 * validate phonemes but cannot prove that a bare greeting gets a useful reply. */
const prompt = "Hey pal.";

const projectApiKey = await resolveProductionProjectApiKey({
  adminApiSecret: process.env.APP_CONFIG_ADMIN_API_SECRET,
  baseUrl,
  projectApiKey: process.env.ITERATE_KIT_PROJECT_API_KEY,
  projectId,
});

using project = await connectItxReady({
  auth: { projectId, secret: projectApiKey, type: "project-secret" },
  baseUrl,
  projectId,
});
using worker = project.workers.get(kitVoiceWorkerRef) as unknown as {
  [Symbol.dispose](): void;
  finishPcmDiagnosticCapture(): Promise<unknown>;
  pcmMetrics(): Promise<Record<string, unknown> | null>;
  startPcmDiagnosticCapture(maximumFrames: number): Promise<boolean>;
};
const root = project.capabilityHosts.get("/");
const devicePath = kitDeviceCapabilityPath(deviceId);
const invoke = async (members: string[]) =>
  await root.invokeCapability({ args: [], path: [...devicePath, ...members] });
const stream = project.streams.get(kitDeviceEventStreamPath(deviceId));
const head = await stream.getEventPage({
  afterOffset: Number.MAX_SAFE_INTEGER,
  eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
  limit: 1,
});

/*
 * The test is unattended, so establish one known generation rather than
 * borrowing whatever conversational state a person left behind. These remote
 * transitions are the same device capabilities as its physical controls.
 */
await invoke(["conversation", "hangUp"]);
await delay(750);
if ((await invoke(["conversation", "start"])) !== true) {
  throw new Error("StackChan rejected the remotely triggered conversation start.");
}

const ready = await waitForMetrics(
  worker,
  (metrics) =>
    metrics.deviceId === deviceId &&
    metrics.conversationActive === true &&
    metrics.providerAvailable === true &&
    typeof metrics.providerSessionReadyAtMs === "number",
  20_000,
);
if (!(await worker.startPcmDiagnosticCapture(300))) {
  throw new Error("The production worker rejected the explicitly bounded Grok capture.");
}

/*
 * Preserve the workstation's volume. Forty percent is intelligible to the
 * adjacent array without recreating the excessively loud physical tests that
 * disturbed the room previously.
 */
const originalVolume = Number(
  (await executeFile("osascript", ["-e", "output volume of (get volume settings)"])).stdout.trim(),
);
try {
  await executeFile("osascript", ["-e", "set volume output volume 40"]);
  await executeFile("say", ["-r", "165", prompt]);
  await delay(1_000);
} finally {
  await executeFile("osascript", ["-e", `set volume output volume ${originalVolume}`]);
}

const capture = parseProductionAecDiagnosticCapture(await worker.finishPcmDiagnosticCapture());
let after = await worker.pcmMetrics();
let vadWaitError: string | null = null;
let responseWaitError: string | null = null;
let playbackWaitError: string | null = null;
try {
  after = await waitForMetrics(
    worker,
    (metrics) => Number(metrics.providerSpeechStops ?? 0) > Number(ready.providerSpeechStops ?? 0),
    15_000,
  );
} catch (error) {
  /*
   * A missed VAD edge is the failure this incident harness is meant to retain.
   * The old fail-fast path threw after successfully capturing the exact uplink,
   * destroying the only waveform that could distinguish quiet/mangled device
   * audio from provider endpointing. Keep the bounded PCM and terminal state;
   * `vadWaitError` makes the evidence explicitly failed rather than silently
   * treating absence as a normal turn.
   */
  vadWaitError = error instanceof Error ? error.message : String(error);
  after = await worker.pcmMetrics();
}
if (vadWaitError === null) {
  try {
    /*
     * `speech_stopped` only hands the turn to Grok; it says nothing about the
     * downlink lifetime. The old fixed 1.5 s delay hung up during a valid
     * longer response and made the physical symptom look like speaker loss.
     * Fence on a provider terminal counter instead. A bounded failure remains
     * evidence, but a successful run can no longer cut its own reply short.
     */
    after = await waitForMetrics(
      worker,
      (metrics) =>
        Number(metrics.providerResponsesCompleted ?? 0) >
          Number(ready.providerResponsesCompleted ?? 0) ||
        Number(metrics.providerResponsesFailed ?? 0) > Number(ready.providerResponsesFailed ?? 0),
      20_000,
    );
  } catch (error) {
    responseWaitError = error instanceof Error ? error.message : String(error);
    after = await worker.pcmMetrics();
  }
}
if (
  responseWaitError === null &&
  Number(after?.providerResponsesCompleted ?? 0) > Number(ready.providerResponsesCompleted ?? 0)
) {
  try {
    /*
     * Provider completion is a production boundary, not an acoustic one. The
     * worker intentionally keeps a bounded reservoir and at most twelve
     * receipt-tracked frames ahead of the speaker. A retained run showed
     * response.done with exactly twelve items still in flight; hanging up at
     * that point discards audible speech while every upstream metric is green.
     * Require both reservoirs to drain before ending the conversation.
     */
    after = await waitForMetrics(
      worker,
      (metrics) =>
        isProductionPcmPlaybackTerminal(
          parsePlaybackTerminalMetrics(metrics),
          parsePlaybackTerminalMetrics(ready),
        ),
      20_000,
    );
  } catch (error) {
    playbackWaitError = error instanceof Error ? error.message : String(error);
    after = await worker.pcmMetrics();
  }
}
const providerEvents = await stream.getEvents({
  afterOffset: head.streamMaxOffset,
  eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
  limit: 300,
});
await invoke(["conversation", "hangUp"]);

const runDirectory = join(
  /*
   * Package scripts run with apps/kit as their working directory. Keeping the
   * path package-relative prevents a successful production capture from being
   * hidden under apps/kit/apps/kit, which previously made the evidence look as
   * though it had never been retained.
   */
  "evidence/stackchan-grok-uplink-incident-20260803",
  new Date().toISOString().replaceAll(/[:.]/gu, "-"),
);
await mkdir(runDirectory, { recursive: true });
await Promise.all([
  writeFile(join(runDirectory, "accepted-uplink.pcm"), capture.pcm, { flag: "wx" }),
  writeFile(
    join(runDirectory, "summary.json"),
    `${JSON.stringify(
      {
        after,
        assessment: assessProductionAecDiagnosticCapture(capture),
        capture: {
          acceptedFrameSpanMs: capture.acceptedFrameSpanMs,
          capturedAudioDurationMs: capture.capturedAudioDurationMs,
          durationMs: capture.durationMs,
          firstAcceptedUplinkFrame: capture.firstAcceptedUplinkFrame,
          frames: capture.frames,
          lastAcceptedUplinkFrame: capture.lastAcceptedUplinkFrame,
          maximumInterFrameGapMs: capture.maximumInterFrameGapMs,
          truncatedFrames: capture.truncatedFrames,
        },
        prompt,
        playbackWaitError,
        ready,
        responseWaitError,
        vadObserved:
          Number(after?.providerSpeechStops ?? 0) > Number(ready.providerSpeechStops ?? 0),
        vadWaitError,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  ),
  writeFile(
    join(runDirectory, "provider-events.json"),
    `${JSON.stringify(providerEvents, null, 2)}\n`,
    { flag: "wx" },
  ),
]);
console.log(JSON.stringify({ runDirectory, prompt }, null, 2));

async function waitForMetrics(
  target: { pcmMetrics(): Promise<Record<string, unknown> | null> },
  predicate: (metrics: Record<string, unknown>) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await target.pcmMetrics();
    if (last && predicate(last)) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for PCM state: ${JSON.stringify(last)}`);
}

function parsePlaybackTerminalMetrics(metrics: Record<string, unknown>) {
  return {
    downlinkItemsAcknowledged: Number(metrics.downlinkItemsAcknowledged ?? -1),
    downlinkItemsInFlight: Number(metrics.downlinkItemsInFlight ?? -1),
    downlinkItemsSent: Number(metrics.downlinkItemsSent ?? -2),
    downlinkQueuedBytes: Number(metrics.downlinkQueuedBytes ?? -1),
    providerResponsesCompleted: Number(metrics.providerResponsesCompleted ?? -1),
    providerResponsesFailed: Number(metrics.providerResponsesFailed ?? -1),
  };
}
