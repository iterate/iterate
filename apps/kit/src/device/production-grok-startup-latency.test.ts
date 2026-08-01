import { describe, expect, test } from "vitest";
import {
  assessProductionGrokStartupLatency,
  productionGrokMaximumFirstAudioLatencyMs,
} from "./production-grok-startup-latency.ts";

describe("production Grok call-start latency", () => {
  test("accepts the measured prewarmed path within the physical first-audio budget", () => {
    /*
     * The customer-visible boundary starts at Button B's conversation event
     * and ends only once PCM is sent back to the physical device. Provider
     * connection alone is not success: generation or downstream delivery can
     * still leave the screen saying Connecting for several more seconds.
     */
    expect(
      assessProductionGrokStartupLatency({
        credentialReadyBeforeConversationMs: 825,
        firstDevicePcmFromConversationMs: 1_473,
        firstProviderPcmFromConversationMs: 1_264,
        providerSessionReadyFromConversationMs: 629,
        providerWebSocketOpenFromConversationMs: 430,
      }),
    ).toEqual({
      maximumFirstAudioLatencyMs: productionGrokMaximumFirstAudioLatencyMs,
      observedFirstAudioLatencyMs: 1_473,
      passed: true,
      reasons: [],
    });
  });

  test("rejects the old synchronous credential path even when the turn eventually works", () => {
    /*
     * Before credential prewarming, an otherwise healthy production run took
     * 4,006 ms from conversation start to the first device PCM frame. Digital
     * frame conservation later passed, so without this explicit UX gate that
     * regression would once again look green.
     */
    const assessment = assessProductionGrokStartupLatency({
      credentialReadyBeforeConversationMs: 0,
      firstDevicePcmFromConversationMs: 4_006,
      firstProviderPcmFromConversationMs: 3_874,
      providerSessionReadyFromConversationMs: 3_314,
      providerWebSocketOpenFromConversationMs: 3_105,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toEqual([
      `first device audio 4006ms exceeds ${productionGrokMaximumFirstAudioLatencyMs}ms`,
    ]);
  });

  test("rejects missing first-audio timing instead of silently skipping the gate", () => {
    const assessment = assessProductionGrokStartupLatency({
      firstDevicePcmFromConversationMs: null,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toEqual([
      "first device audio latency from conversation start was not observed",
    ]);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects malformed first-audio timing %s",
    (firstDevicePcmFromConversationMs) => {
      const assessment = assessProductionGrokStartupLatency({
        firstDevicePcmFromConversationMs,
      });

      expect(assessment.passed).toBe(false);
      expect(assessment.reasons).toEqual([
        "first device audio latency from conversation start is not a non-negative integer",
      ]);
    },
  );
});
