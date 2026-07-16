/**
 * Hermes has atob but not Buffer; decode the picker's base64 into the bytes
 * capnweb sends to `agent.addFiles`. Kept separate from attachments.ts so the
 * pure part is importable under Node (vitest / the live e2e).
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
