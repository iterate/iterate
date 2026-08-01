/**
 * Button B to first physical-device PCM is the customer-visible call-start
 * boundary. The 2.5-second ceiling leaves room for ordinary provider/network
 * variation around the measured 1.473-second production run while still
 * making the former 4.006-second synchronous-credential path a hard failure.
 * Tighten this from a distribution of clean runs; do not raise it to absorb an
 * unexplained regression.
 */
export const productionGrokMaximumFirstAudioLatencyMs = 2_500;

export interface ProductionGrokStartupTiming {
  credentialReadyBeforeConversationMs?: number | null;
  firstDevicePcmFromConversationMs?: number | null;
  firstProviderPcmFromConversationMs?: number | null;
  providerSessionReadyFromConversationMs?: number | null;
  providerWebSocketOpenFromConversationMs?: number | null;
}

export interface ProductionGrokStartupLatencyAssessment {
  maximumFirstAudioLatencyMs: number;
  observedFirstAudioLatencyMs: number | null;
  passed: boolean;
  reasons: string[];
}

/** Judges the full userspace/provider/downlink startup path, not a partial handshake. */
export function assessProductionGrokStartupLatency(
  timing: ProductionGrokStartupTiming,
): ProductionGrokStartupLatencyAssessment {
  const observedFirstAudioLatencyMs = timing.firstDevicePcmFromConversationMs ?? null;
  const reasons: string[] = [];
  if (observedFirstAudioLatencyMs === null) {
    reasons.push("first device audio latency from conversation start was not observed");
  } else if (
    !Number.isSafeInteger(observedFirstAudioLatencyMs) ||
    observedFirstAudioLatencyMs < 0
  ) {
    reasons.push(
      "first device audio latency from conversation start is not a non-negative integer",
    );
  } else if (observedFirstAudioLatencyMs > productionGrokMaximumFirstAudioLatencyMs) {
    reasons.push(
      `first device audio ${observedFirstAudioLatencyMs}ms exceeds ` +
        `${productionGrokMaximumFirstAudioLatencyMs}ms`,
    );
  }

  return {
    maximumFirstAudioLatencyMs: productionGrokMaximumFirstAudioLatencyMs,
    observedFirstAudioLatencyMs,
    passed: reasons.length === 0,
    reasons,
  };
}
