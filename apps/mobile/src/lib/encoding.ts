/**
 * Hermes has atob but not Buffer; decode the picker's base64 into the bytes
 * capnweb sends to `agent.addFiles`. Kept separate from attachments.ts so the
 * pure part is importable under Node (vitest / the live e2e).
 */
// The narrow Uint8Array<ArrayBuffer> return matters: `new Uint8Array(n)` is
// always ArrayBuffer-backed, and consumers hand these bytes to APIs typed
// against ArrayBuffer views (Blob parts in the filter pipeline).
export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes → base64 (chunked: Hermes has btoa but String.fromCharCode has an
 * argument-count ceiling). The sync engine hashes and uploads base64, same
 * as the picker path, so content hashes stay comparable. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}
