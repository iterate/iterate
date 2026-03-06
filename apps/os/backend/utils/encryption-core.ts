/**
 * Core encryption utilities that don't depend on Cloudflare env.
 * Use these in scripts or when you need to pass the secret explicitly.
 *
 * For worker context, use the convenience wrappers in encryption.ts instead.
 */

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const SALT = "pangyo-env-vars";

/**
 * Encrypt plaintext using AES-GCM with a provided secret.
 */
export async function encryptWithSecret(
  plaintext: string,
  encryptionSecret: string,
): Promise<string> {
  const key = await deriveKey(encryptionSecret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt ciphertext using AES-GCM with a provided secret.
 */
export async function decryptWithSecret(
  encrypted: string,
  encryptionSecret: string,
): Promise<string> {
  const key = await deriveKey(encryptionSecret, ["decrypt"]);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function deriveKey(
  secret: string,
  keyUsages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(SALT),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    keyUsages,
  );
}
