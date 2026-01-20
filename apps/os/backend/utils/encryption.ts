/**
 * Encryption utilities for the Cloudflare Worker context.
 *
 * For scripts that run outside the worker (e.g., seed scripts),
 * use encryption-core.ts directly with encryptWithSecret/decryptWithSecret.
 */

import { env } from "../cloudflare-env.ts";
import { encryptWithSecret, decryptWithSecret } from "./encryption-core.ts";

// Re-export core functions for convenience
export { encryptWithSecret, decryptWithSecret } from "./encryption-core.ts";

/**
 * Encrypt plaintext using ENCRYPTION_SECRET from Cloudflare env.
 * Use this in the worker context where env is available.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const secret = env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET not configured");
  return encryptWithSecret(plaintext, secret);
}

/**
 * Decrypt ciphertext using ENCRYPTION_SECRET from Cloudflare env.
 * Use this in the worker context where env is available.
 */
export async function decrypt(encrypted: string): Promise<string> {
  const secret = env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET not configured");
  return decryptWithSecret(encrypted, secret);
}
