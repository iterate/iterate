// Tiny webcrypto helpers shared by provider webhook verification.

export async function hmacSha256Hex(input: { secret: string; message: string }): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input.message));
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyEd25519Hex(input: {
  publicKeyHex: string;
  signatureHex: string;
  message: string;
}): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(input.publicKeyHex) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    hexToBytes(input.signatureHex) as BufferSource,
    new TextEncoder().encode(input.message),
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hexString: string): Uint8Array {
  const bytes = new Uint8Array(hexString.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexString.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
