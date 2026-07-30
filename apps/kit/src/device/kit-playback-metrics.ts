import { z } from "zod";
import type { KitPlaybackMetrics } from "./kit-device-contract.ts";

/*
 * Keep these lists beside the runtime parser instead of deriving validation
 * from a TypeScript interface. The interface disappears at runtime, while this
 * callback crosses an independently implemented C/JSON boundary and becomes
 * release evidence. A truncated serializer or a stale firmware schema must
 * fail at receipt; accepting a partial object and defaulting missing counters
 * to zero could turn absent instrumentation into a clean endurance result.
 */
const playbackFieldNames = [
  "submitted",
  "completed",
  "generationFramesFlushed",
  "freshnessFramesDropped",
  "partialPrebufferFramesDropped",
  "underrunFramesFlushed",
  "underrunIncidents",
  "underrunSilenceFramesSubmitted",
  "underrunSilenceFramesCompleted",
  "underrunSilenceFramesRetired",
  "underrunLateFramesDropped",
  "dmaDeadlineMissIncidents",
  "freshnessIncidents",
  "partialPrebufferIncidents",
  "endOfStreamMarkersConsumed",
  "endOfStreamResponses",
  "endOfStreamSilenceDescriptors",
  "endOfStreamPaddingDescriptorsCompleted",
  "driverQueueOverflowIncidents",
  "driverFailures",
  "driverStopFailures",
  "fatalFramesFlushed",
  "writeBackpressureIncidents",
  "writeBackpressureDestructiveResets",
  "writeBackpressureFramesDropped",
  "invalidFrames",
  "stateErrors",
  "ownerClockRegressions",
  "successfulRefillTimingSamples",
  "lastEofToSuccessfulRefillUs",
  "maximumEofToSuccessfulRefillUs",
  "lastWriteCallDurationUs",
  "maximumWriteCallDurationUs",
  "lastReuseLeadAtSuccessfulRefillUs",
  "minimumReuseLeadAtSuccessfulRefillUs",
] as const satisfies readonly (keyof KitPlaybackMetrics["playback"])[];

const runtimeUnsignedFieldNames = [
  "audioOwnerStackHeadroomBytes",
  "mainStackHeadroomBytes",
  "controlNetworkStackHeadroomBytes",
  "pcmNetworkStackHeadroomBytes",
  "freeInternalHeapBytes",
  "minimumFreeInternalHeapBytes",
  "freeDmaHeapBytes",
  "minimumFreeDmaHeapBytes",
  "largestFreeInternalHeapBlockBytes",
  "largestFreeDmaBlockBytes",
  "generationFenceAcknowledgementTimeouts",
  "lifecycleAcknowledgementTimeouts",
  "controlNetworkStackExhaustions",
  "pcmNetworkStackExhaustions",
  "controlNetworkMaximumWorkCycles",
  "pcmNetworkMaximumWorkCycles",
] as const satisfies readonly (keyof KitPlaybackMetrics["runtime"])[];

const uint32 = z.number().int().min(0).max(0xffff_ffff);
const monotonicMilliseconds = z.number().int().nonnegative().safe();

function requiredNumericShape<const Name extends string>(
  names: readonly Name[],
  schema: z.ZodType<number>,
) {
  return Object.fromEntries(names.map((name) => [name, schema])) as Record<Name, z.ZodType<number>>;
}

const playbackMetricsSchema = z.strictObject({
  schemaVersion: z.literal(3),
  sequence: uint32,
  producedAtMs: monotonicMilliseconds,
  downlinkAccepted: uint32,
  playback: z.strictObject(requiredNumericShape(playbackFieldNames, uint32)),
  runtime: z.strictObject({
    ...requiredNumericShape(runtimeUnsignedFieldNames, uint32),
    /*
     * The first ESP task-runtime sample has no preceding interval and uses -1
     * explicitly. Do not coerce that to zero CPU: zero is a real observation,
     * while -1 says the measurement is not available yet.
     */
    cpuPermille: z.number().int().min(-1).max(1_000),
  }),
});

export function parseKitPlaybackMetrics(value: unknown): KitPlaybackMetrics {
  return playbackMetricsSchema.parse(value) as KitPlaybackMetrics;
}

/**
 * Stable persisted names for the device-neutral endurance judge.
 *
 * The compact wire schema avoids repeated prefixes to stay within one fixed
 * Cap'n Web control slot. Expansion belongs on the host, where RAM is not
 * scarce. `network_stack_headroom_bytes` deliberately means the weaker of the
 * two network tasks; retaining each owner-specific value alongside it keeps
 * the aggregate conservative without erasing diagnostic detail.
 */
export function flattenKitPlaybackMetrics(metrics: KitPlaybackMetrics): Record<string, number> {
  const flattened: Record<string, number> = {
    downlink_accepted: metrics.downlinkAccepted,
  };
  for (const name of playbackFieldNames) {
    flattened[`playback_${camelCaseToSnakeCase(name)}`] = metrics.playback[name];
  }
  for (const name of runtimeUnsignedFieldNames) {
    flattened[camelCaseToSnakeCase(name)] = metrics.runtime[name];
  }
  flattened.cpu_permille = metrics.runtime.cpuPermille;
  flattened.control_stack_headroom_bytes = metrics.runtime.controlNetworkStackHeadroomBytes;
  flattened.network_stack_headroom_bytes = Math.min(
    metrics.runtime.controlNetworkStackHeadroomBytes,
    metrics.runtime.pcmNetworkStackHeadroomBytes,
  );
  return flattened;
}

function camelCaseToSnakeCase(name: string) {
  return name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}
