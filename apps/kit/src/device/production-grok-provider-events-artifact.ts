import { writeFile } from "node:fs/promises";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
} from "../userspace/config-worker/provider-event-stream.ts";
import type { ProductionGrokProviderEvent } from "./production-grok-provider-events.ts";

export interface ProductionGrokProviderEventsArtifact {
  continuity: {
    discontinuities: Array<{
      expectedSequence: number;
      observedSequence: number;
    }>;
    expectedFirstSequence: number;
    firstObservedSequence: number;
    lastObservedSequence: number;
    verdict: "contiguous-from-expected" | "contiguous-from-one" | "discontinuous";
  };
  eventCount: number;
  path: string;
  sessionId: string;
}

/**
 * Retains one line per upstream control frame without parsing or normalising
 * `raw`. JSONL makes the provider chronology inspectable with ordinary shell
 * tools while preserving the Iterate stream offset needed to trace each line
 * back to its durable envelope.
 *
 * The complete payload is assembled and checked before the exclusive write.
 * If a provider ever reflects a runtime credential, redaction would destroy
 * the lossless evidence contract, so the safe outcome is no artifact at all.
 */
export async function writeProductionGrokProviderEventsArtifact(input: {
  artifactPath: string;
  deviceId: string;
  events: readonly ProductionGrokProviderEvent[];
  expectedFirstSequence?: number;
  sensitiveValues: readonly string[];
}): Promise<ProductionGrokProviderEventsArtifact> {
  if (input.events.length === 0) {
    throw new Error("A provider-event artifact requires at least one event.");
  }
  const expectedFirstSequence = input.expectedFirstSequence ?? 1;
  if (!Number.isSafeInteger(expectedFirstSequence) || expectedFirstSequence < 1) {
    throw new Error("The expected first provider-event sequence must be a positive integer.");
  }
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const sessionId = events[0]!.sessionId;
  const streamPath = kitDeviceEventStreamPath(input.deviceId);
  /*
   * A warm device PCM generation can outlive several disposable provider
   * calls. The proof deliberately snapshots the durable stream only after the
   * previous call has drained, so its artifact is a suffix of that generation.
   * Starting from the caller's measured boundary preserves strict loss
   * detection without falsely declaring every later call's first frame to be
   * a missing 1..N prefix.
   */
  let expectedSequence = expectedFirstSequence;
  const discontinuities: Array<{ expectedSequence: number; observedSequence: number }> = [];
  const lines = events.map((event) => {
    if (event.sessionId !== sessionId) {
      throw new Error("Provider-event artifact cannot mix PCM sessions.");
    }
    if (event.sequence !== expectedSequence) {
      discontinuities.push({ expectedSequence, observedSequence: event.sequence });
    }
    expectedSequence = event.sequence + 1;
    return JSON.stringify({
      createdAt: event.createdAt,
      offset: event.offset,
      path: streamPath,
      providerType: event.providerType,
      raw: event.raw,
      receivedAtMs: event.receivedAtMs,
      sequence: event.sequence,
      sessionId: event.sessionId,
      type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
    });
  });
  const encoded = `${lines.join("\n")}\n`;
  if (
    input.sensitiveValues.some(
      (sensitiveValue) => sensitiveValue.length > 0 && encoded.includes(sensitiveValue),
    )
  ) {
    throw new Error("Provider-event evidence contained a protected runtime secret.");
  }

  await writeFile(input.artifactPath, encoded, { encoding: "utf8", flag: "wx" });
  return {
    continuity: {
      discontinuities,
      expectedFirstSequence,
      firstObservedSequence: events[0]!.sequence,
      lastObservedSequence: events.at(-1)!.sequence,
      verdict:
        discontinuities.length > 0
          ? "discontinuous"
          : expectedFirstSequence === 1
            ? "contiguous-from-one"
            : "contiguous-from-expected",
    },
    eventCount: events.length,
    path: input.artifactPath,
    sessionId,
  };
}
