/**
 * Button B to a configured provider session is the manual-PTT call-start
 * boundary. The device must remain silent at this point: requiring downlink
 * PCM here would turn the deliberately removed unsolicited greeting into the
 * harness's success oracle. The 2.5-second ceiling still rejects the measured
 * 3.314-second synchronous-credential path while leaving margin around the
 * current 672 ms production result. First-answer latency belongs to each PTT
 * turn and must be measured from its release, not from opening the call.
 */
export const productionGrokMaximumProviderReadyLatencyMs = 2_500;

export interface ProductionGrokStartupTiming {
  credentialReadyBeforeConversationMs?: number | null;
  firstDevicePcmFromConversationMs?: number | null;
  firstProviderPcmFromConversationMs?: number | null;
  providerSessionReadyFromConversationMs?: number | null;
  providerWebSocketOpenFromConversationMs?: number | null;
}

export interface ProductionGrokStartupLatencyAssessment {
  maximumProviderReadyLatencyMs: number;
  observedProviderReadyLatencyMs: number | null;
  passed: boolean;
  reasons: string[];
}

/** Judges whether call infrastructure is ready without authorizing provider speech. */
export function assessProductionGrokStartupLatency(
  timing: ProductionGrokStartupTiming,
): ProductionGrokStartupLatencyAssessment {
  const observedProviderReadyLatencyMs = timing.providerSessionReadyFromConversationMs ?? null;
  const reasons: string[] = [];
  if (observedProviderReadyLatencyMs === null) {
    reasons.push("provider session readiness from conversation start was not observed");
  } else if (
    !Number.isSafeInteger(observedProviderReadyLatencyMs) ||
    observedProviderReadyLatencyMs < 0
  ) {
    reasons.push(
      "provider session readiness from conversation start is not a non-negative integer",
    );
  } else if (observedProviderReadyLatencyMs > productionGrokMaximumProviderReadyLatencyMs) {
    reasons.push(
      `provider session readiness ${observedProviderReadyLatencyMs}ms exceeds ` +
        `${productionGrokMaximumProviderReadyLatencyMs}ms`,
    );
  }

  return {
    maximumProviderReadyLatencyMs: productionGrokMaximumProviderReadyLatencyMs,
    observedProviderReadyLatencyMs,
    passed: reasons.length === 0,
    reasons,
  };
}
