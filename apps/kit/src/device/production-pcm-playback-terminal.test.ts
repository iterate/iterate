import { describe, expect, test } from "vitest";
import { isProductionPcmPlaybackTerminal } from "./production-pcm-playback-terminal.ts";

describe("production PCM playback terminal", () => {
  test("does not confuse provider completion with physical playback completion", () => {
    /*
     * A retained StackChan incident reached `response.done` with twelve frames
     * still receipt-tracked and 53,432 bytes still in userspace. Ending the
     * conversation there clipped a perfectly healthy response. Provider state
     * is therefore only the first fence; both bounded reservoirs must drain
     * and the device receipt ledger must conserve every sent item.
     */
    expect(
      isProductionPcmPlaybackTerminal({
        downlinkItemsAcknowledged: 12,
        downlinkItemsInFlight: 12,
        downlinkItemsSent: 24,
        downlinkQueuedBytes: 53_432,
        providerResponsesCompleted: 1,
        providerResponsesFailed: 0,
      }),
    ).toBe(false);

    expect(
      isProductionPcmPlaybackTerminal({
        downlinkItemsAcknowledged: 525,
        downlinkItemsInFlight: 0,
        downlinkItemsSent: 525,
        downlinkQueuedBytes: 0,
        providerResponsesCompleted: 1,
        providerResponsesFailed: 0,
      }),
    ).toBe(true);
  });

  test("rejects a drained failed response and impossible receipt accounting", () => {
    expect(
      isProductionPcmPlaybackTerminal({
        downlinkItemsAcknowledged: 0,
        downlinkItemsInFlight: 0,
        downlinkItemsSent: 0,
        downlinkQueuedBytes: 0,
        providerResponsesCompleted: 0,
        providerResponsesFailed: 1,
      }),
    ).toBe(false);
    expect(
      isProductionPcmPlaybackTerminal({
        downlinkItemsAcknowledged: 11,
        downlinkItemsInFlight: 0,
        downlinkItemsSent: 12,
        downlinkQueuedBytes: 0,
        providerResponsesCompleted: 1,
        providerResponsesFailed: 0,
      }),
    ).toBe(false);
  });
});
