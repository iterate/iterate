import { connectItxReady } from "iterate/node";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
} from "../src/userspace/config-worker/provider-event-stream.ts";

const projectId = process.env.ITERATE_KIT_PROJECT_ID?.trim() ?? "";
const projectApiKey = process.env.ITERATE_KIT_PROJECT_API_KEY?.trim() ?? "";
const deviceId = process.env.ITERATE_KIT_DEVICE_ID?.trim() || "m5sticks3";

if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
  throw new Error("ITERATE_KIT_PROJECT_ID must identify the production proof project.");
}
if (!projectApiKey) throw new Error("ITERATE_KIT_PROJECT_API_KEY is required.");

using project = await connectItxReady(
  {
    auth: { projectId, secret: projectApiKey, type: "project-secret" },
    baseUrl: "https://os.iterate.com",
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

const [metrics, deviceDiagnostics, repoLog] = await Promise.all([
  worker.pcmMetrics(),
  capabilityRoot.invokeCapability({
    args: [],
    path: ["kit", deviceId, "getDiagnostics"],
  }),
  project.repo.log({ limit: 12 }),
]);

console.log(
  JSON.stringify(
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
  ),
);
