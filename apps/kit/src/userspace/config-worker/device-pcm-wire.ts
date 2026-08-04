/*
 * The device-to-userspace PCM WebSocket has two binary domains on one ordered
 * transport: fixed-size microphone media and this cumulative speaker-release
 * fact. The receipt exists because `WebSocket.send()` only proves that bytes
 * entered a transport implementation; it cannot say when I2S released the
 * corresponding playback item. Production uses the count as finite downlink
 * credit and to truncate interrupted provider history at hardware-played time.
 * Local deterministic harnesses do not own that credit ledger, but they still
 * have to recognize the same firmware wire message and keep it off the uplink.
 *
 * This implementation lives inside the deployable config-worker directory on
 * purpose. kitVoiceWorkerRef snapshots only apps/kit-voice/** from the config
 * repository, so an apparently shared sibling outside that mask commits cleanly
 * but fails only when production cold-starts the worker. Host-side code
 * re-exports this module rather than maintaining a second wire interpretation.
 */
export const ITERATE_KIT_PCM_DOWNLINK_RELEASE_RECEIPT_BYTES = 8;

export function decodePcmDownlinkReleaseReceipt(bytes: Uint8Array | null): number | null {
  if (
    bytes === null ||
    bytes.byteLength !== ITERATE_KIT_PCM_DOWNLINK_RELEASE_RECEIPT_BYTES ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x41 ||
    bytes[3] !== 1
  ) {
    return null;
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
}
