import { describe, expect, test } from "vitest";
import {
  assessProductionGrokStartupLatency,
  productionGrokMaximumProviderReadyLatencyMs,
} from "./production-grok-startup-latency.ts";

describe("production Grok call-start latency", () => {
  test("accepts a prewarmed manual-PTT call that is ready and deliberately silent", () => {
    /*
     * Button B starts infrastructure, not an assistant turn. This is the exact
     * shape captured before the first remote PTT in production: provider ready
     * in 672 ms and no device/provider PCM. Requiring first audio would reward
     * the unsolicited "How can I help you?" behavior this product forbids.
     */
    expect(
      assessProductionGrokStartupLatency({
        credentialReadyBeforeConversationMs: 10_526,
        firstDevicePcmFromConversationMs: null,
        firstProviderPcmFromConversationMs: null,
        providerSessionReadyFromConversationMs: 672,
        providerWebSocketOpenFromConversationMs: 480,
      }),
    ).toEqual({
      maximumProviderReadyLatencyMs: productionGrokMaximumProviderReadyLatencyMs,
      observedProviderReadyLatencyMs: 672,
      passed: true,
      reasons: [],
    });
  });

  test("rejects the old synchronous credential path before any PTT is attempted", () => {
    /*
     * Before credential prewarming the provider session itself took 3,314 ms
     * after Button B. Later PCM conservation cannot make that call-opening
     * stall acceptable, even though first audio is no longer a start oracle.
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
      `provider session readiness 3314ms exceeds ${productionGrokMaximumProviderReadyLatencyMs}ms`,
    ]);
  });

  test("rejects missing provider readiness instead of mistaking silence for readiness", () => {
    const assessment = assessProductionGrokStartupLatency({
      firstDevicePcmFromConversationMs: null,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toEqual([
      "provider session readiness from conversation start was not observed",
    ]);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects malformed provider readiness timing %s",
    (providerSessionReadyFromConversationMs) => {
      const assessment = assessProductionGrokStartupLatency({
        providerSessionReadyFromConversationMs,
      });

      expect(assessment.passed).toBe(false);
      expect(assessment.reasons).toEqual([
        "provider session readiness from conversation start is not a non-negative integer",
      ]);
    },
  );
});
