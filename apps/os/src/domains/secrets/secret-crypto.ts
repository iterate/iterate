// AES-256-GCM envelope for Secret material inside event payloads.
//
// Secret lifecycle events are ordinary stream events — they replicate wherever
// streams replicate (debug UIs, history exports, processor checkpoints). The
// envelope is what makes that safe: journals carry ciphertext only, and the
// deployment key (SECRETS_ENCRYPTION_KEY, 32 random bytes, base64) never
// appears in any payload. Decryption happens inside the Secret Durable Object
// (secret-durable-object.ts) and nowhere else.

import { z } from "zod";

export const EncryptedMaterial = z.object({
  envelope: z.literal("aes-256-gcm.v1"),
  iv: z.string(),
  ciphertext: z.string(),
});
export type EncryptedMaterial = z.infer<typeof EncryptedMaterial>;

export async function importSecretsKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.byteLength !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded.");
  }
  return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecretMaterial(input: {
  key: CryptoKey;
  material: string;
}): Promise<EncryptedMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    input.key,
    new TextEncoder().encode(input.material),
  );
  return {
    envelope: "aes-256-gcm.v1",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSecretMaterial(input: {
  key: CryptoKey;
  encrypted: EncryptedMaterial;
}): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(input.encrypted.iv) as BufferSource },
    input.key,
    base64ToBytes(input.encrypted.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/** One-off helper for minting a deployment key (`pnpm tsx -e ...` or a REPL). */
export function generateSecretsKeyBase64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
