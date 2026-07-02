const ALGORITHM = "AES-GCM-SHA256" as const;

export async function encryptSecretMaterial(material: string, keyMaterial: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importSecretKey(keyMaterial);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(material),
  );
  return {
    algorithm: ALGORITHM,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptSecretMaterial(
  encrypted: { algorithm: typeof ALGORITHM; ciphertext: string; iv: string },
  keyMaterial: string,
): Promise<string> {
  const key = await importSecretKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToArrayBuffer(encrypted.iv) },
    key,
    base64ToArrayBuffer(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function importSecretKey(keyMaterial: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt", "encrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}
