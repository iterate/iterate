import { connectItxReady } from "iterate/node";
import { resolveProductionProjectApiKey } from "../src/device/production-project-api-key.ts";
import { captureIncidentDiagnostic } from "../src/device/incident-diagnostic.ts";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
} from "../src/userspace/config-worker/provider-event-stream.ts";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";

const projectId = process.env.ITERATE_KIT_PROJECT_ID?.trim() ?? "";
const deviceId = process.env.ITERATE_KIT_DEVICE_ID?.trim() || "m5sticks3";
const streamOnly = process.env.ITERATE_KIT_INCIDENT_STREAM_ONLY === "1";
const baseUrl = "https://os.iterate.com";
const diagnosticTimeoutMs = 5_000;

if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
  throw new Error("ITERATE_KIT_PROJECT_ID must identify the production proof project.");
}
/*
 * Incident collection must remain usable when the operator has only the
 * normal Doppler-backed production admin credential. Resolve the project's
 * narrow ingress key in memory through the same pairing seam as the proof
 * harness; requiring a manually copied secret during an active physical
 * failure loses the most valuable provider and socket evidence.
 */
const projectApiKey = await resolveProductionProjectApiKey({
  adminApiSecret: process.env.APP_CONFIG_ADMIN_API_SECRET,
  baseUrl,
  projectApiKey: process.env.ITERATE_KIT_PROJECT_API_KEY,
  projectId,
});

using project = await connectItxReady(
  {
    auth: { projectId, secret: projectApiKey, type: "project-secret" },
    baseUrl,
    projectId,
  },
  {
    retryInitialConnection: {
      delayMs: 250,
      onRetry: ({ delayMs, error }) => {
        console.warn(
          JSON.stringify({ code: "stick-incident-inspector-connect-retry", delayMs, error }),
        );
      },
    },
  },
);

/*
 * This inspector deliberately resolves the already-installed worker ref; it
 * never commits project source, remounts a capability, calls kill(), or opens
 * /pcm. Keeping incident collection read-only matters because otherwise the
 * act of diagnosing a generation failure can manufacture another generation
 * failure and destroy the evidence we are trying to attribute.
 *
 * The pipelined ITX proxy cannot know the concrete methods exported by source
 * in the project's config repo. The local source-controlled ref does, so this
 * narrow structural cast documents exactly the one diagnostic method we call.
 */
using worker = project.workers.get(kitVoiceWorkerRef) as unknown as {
  [Symbol.dispose](): void;
  pcmMetrics(): Promise<unknown>;
};

const capabilityRoot = project.capabilityHosts.get("/");
const stream = project.streams.get(kitDeviceEventStreamPath(deviceId));

/*
 * getEvents() pages forward from offset zero. First take an atomic empty page
 * beyond the end solely to learn streamMaxOffset, then bound the real read to
 * the last 300 raw offsets. This remains cheap even after weeks of calls and
 * ensures a reset investigation sees the most recent provider lifecycle.
 */
const head = await stream.getEventPage({
  afterOffset: Number.MAX_SAFE_INTEGER,
  eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
  limit: 1,
});
const providerEvents = await stream.getEvents({
  afterOffset: Math.max(0, head.streamMaxOffset - 300),
  eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
  limit: 300,
});

/*
 * The raw provider stream is the irreplaceable timing record during a live
 * voice incident. A wedged device control socket or unrelated repository read
 * must not prevent an operator from collecting it. Stream-only mode therefore
 * omits those secondary calls explicitly; it does not substitute nulls that a
 * later reader could mistake for successful diagnostics.
 */
const [metrics, deviceDiagnostics, repoLog] = streamOnly
  ? [
      { skipped: true, reason: "ITERATE_KIT_INCIDENT_STREAM_ONLY" },
      { skipped: true, reason: "ITERATE_KIT_INCIDENT_STREAM_ONLY" },
      { skipped: true, reason: "ITERATE_KIT_INCIDENT_STREAM_ONLY" },
    ]
  : await Promise.all([
      captureIncidentDiagnostic(() => worker.pcmMetrics(), {
        label: "pcmMetrics",
        timeoutMs: diagnosticTimeoutMs,
      }),
      captureIncidentDiagnostic(
        () =>
          capabilityRoot.invokeCapability({
            args: [],
            path: kitDeviceCapabilityPath(deviceId, "getDiagnostics"),
          }),
        { label: "device getDiagnostics", timeoutMs: diagnosticTimeoutMs },
      ),
      captureIncidentDiagnostic(() => project.repo.log({ limit: 12 }), {
        label: "project repo log",
        timeoutMs: diagnosticTimeoutMs,
      }),
    ]);

const artifact = JSON.stringify(
  {
    collectedAt: new Date().toISOString(),
    deviceDiagnostics,
    deviceId,
    metrics,
    projectId,
    providerEvents,
    repoLog,
    streamHead: head.streamMaxOffset,
  },
  null,
  2,
);

/*
 * Promise.race can bound what the collector waits for, but JavaScript cannot
 * cancel a Cap'n Web call that was already dispatched. A physically wedged
 * call may therefore keep the client's WebSocket referenced after its timeout
 * result has been serialized. This file is a one-shot incident CLI, so exiting
 * only after stdout confirms the complete artifact was flushed is the honest
 * cancellation boundary. Relying on natural event-loop emptiness recreated the
 * very indefinite hang the timeout is meant to prevent.
 */
process.stdout.write(`${artifact}\n`, () => process.exit(0));
