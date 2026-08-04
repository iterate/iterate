export interface ProductionPcmPlaybackTerminalMetrics {
  downlinkItemsAcknowledged: number;
  downlinkItemsInFlight: number;
  downlinkItemsSent: number;
  downlinkQueuedBytes: number;
  providerResponsesCompleted: number;
  providerResponsesFailed: number;
}

/**
 * Returns true only after one successful provider response reached the device.
 *
 * `response.done` is a generation boundary, not a speaker boundary. Userspace
 * deliberately maintains a small PCM reservoir and a receipt-tracked window
 * ahead of the device, so ending a call on provider completion can discard
 * speech that has not reached playout yet. The receipt ledger is the closest
 * synchronous production witness: unlike one-second capability metrics, it is
 * updated by the PCM socket itself and cannot be a stale sampled queue depth.
 */
export function isProductionPcmPlaybackTerminal(
  metrics: ProductionPcmPlaybackTerminalMetrics,
  baseline: Pick<
    ProductionPcmPlaybackTerminalMetrics,
    "providerResponsesCompleted" | "providerResponsesFailed"
  > = { providerResponsesCompleted: 0, providerResponsesFailed: 0 },
): boolean {
  return (
    metrics.providerResponsesCompleted > baseline.providerResponsesCompleted &&
    metrics.providerResponsesFailed === baseline.providerResponsesFailed &&
    metrics.downlinkQueuedBytes === 0 &&
    metrics.downlinkItemsInFlight === 0 &&
    metrics.downlinkItemsAcknowledged === metrics.downlinkItemsSent
  );
}
