// secret-at-rest.ts — a project secret's material AT REST: AES-256-GCM under the deployment's key
// (`APP_CONFIG_SECRETS_KEY`, app-config.ts), the ciphertext BOUND to the one place it may be read
// back from — the object's owner and name, the pin it was stored with, and the revision it was
// written at (the additional authenticated data). apps/os's ADR 0005 binding (project, path, pin,
// offset) carried over: a ciphertext copied into another object, under another pin, or back over a
// later write does not open. Rotation: `previous` opens what `current` cannot; the caller re-encrypts
// under `current` when told it happened, so a rotation completes one read at a time and the old key
// can be dropped once every record has been touched.

import type { SecretMaterial } from "./secrets.ts";

/** What the object stores in place of the material. */
export type EncryptedMaterial = {
  algorithm: "AES-256-GCM+SECRET-V1";
  /** base64, 12 bytes */
  iv: string;
  /** base64 */
  ciphertext: string;
};

/** Where a ciphertext is allowed to open: the object (`owner`, `name`), the pin, and the write. */
export type MaterialBinding = { owner: string; name: string; urls: string[]; revision: number };

/** The deployment's keys: any strings — the AES key is the SHA-256 of each. `previous` is set only
 *  while rotating. */
export type MaterialKeys = { current: string; previous?: string };

export async function encryptSecretMaterial(
  material: SecretMaterial,
  binding: MaterialBinding,
  keys: MaterialKeys,
): Promise<EncryptedMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataOf(binding) },
    await aesKeyOf(keys.current),
    new TextEncoder().encode(JSON.stringify(material)),
  );
  return {
    algorithm: "AES-256-GCM+SECRET-V1",
    iv: base64Of(iv),
    ciphertext: base64Of(new Uint8Array(ciphertext)),
  };
}

/** Open a ciphertext at its binding. `rotated` says the PREVIOUS key opened it — the caller writes it
 *  back under the current one. A ciphertext neither key opens, or one bound elsewhere, throws. */
export async function decryptSecretMaterial(
  encrypted: EncryptedMaterial,
  binding: MaterialBinding,
  keys: MaterialKeys,
): Promise<{ material: SecretMaterial; rotated: boolean }> {
  const open = async (key: string) =>
    crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesOf(encrypted.iv),
        additionalData: additionalDataOf(binding),
      },
      await aesKeyOf(key),
      bytesOf(encrypted.ciphertext),
    );
  try {
    return {
      material: JSON.parse(new TextDecoder().decode(await open(keys.current))),
      rotated: false,
    };
  } catch (error) {
    if (!keys.previous) throw error;
    return {
      material: JSON.parse(new TextDecoder().decode(await open(keys.previous))),
      rotated: true,
    };
  }
}

/** The binding as bytes: a fixed tag and version, then the fields in one order (the pin sorted, so
 *  the same set of origins in any spelling is the same binding). Copied into a plain ArrayBuffer —
 *  what WebCrypto's BufferSource asks for. */
function additionalDataOf(binding: MaterialBinding): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify([
        "iterate-secret",
        1,
        binding.owner,
        binding.name,
        [...new Set(binding.urls)].sort(),
        binding.revision,
      ]),
    ),
  );
}

async function aesKeyOf(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passphrase));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
