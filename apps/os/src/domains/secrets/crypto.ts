const ALGORITHM = "AES-GCM-SHA256" as const;
const SECRET_CELL_ALGORITHM = "AES-GCM-SHA256+SECRET-CELL-V1" as const;

type SecretCellMaterialBinding = {
  egressOrigins: readonly string[];
  offset: number;
  path: string;
  projectId: string;
};

type SecretCellEncryptedMaterial = {
  algorithm: typeof SECRET_CELL_ALGORITHM;
  ciphertext: string;
  iv: string;
};

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

/**
 * Encrypt material for exactly one committed secret-cell state. The stream
 * offset makes every envelope single-use; project/path/origin binding prevents
 * ciphertext copied from another cell or policy from authenticating.
 */
export async function encryptSecretCellMaterial(
  material: string,
  keyMaterial: string,
  binding: SecretCellMaterialBinding,
): Promise<SecretCellEncryptedMaterial> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importSecretKey(keyMaterial);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: secretCellAdditionalData(binding) },
    key,
    new TextEncoder().encode(material),
  );
  return {
    algorithm: SECRET_CELL_ALGORITHM,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptSecretCellMaterial(
  encrypted: SecretCellEncryptedMaterial,
  keyMaterial: string,
  binding: SecretCellMaterialBinding,
): Promise<string> {
  const key = await importSecretKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToArrayBuffer(encrypted.iv),
      additionalData: secretCellAdditionalData(binding),
    },
    key,
    base64ToArrayBuffer(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function secretCellAdditionalData(binding: SecretCellMaterialBinding): ArrayBuffer {
  const origins = [...new Set(binding.egressOrigins)].sort();
  return new TextEncoder().encode(
    JSON.stringify([
      "iterate-secret-cell",
      1,
      binding.projectId,
      binding.path,
      origins,
      binding.offset,
    ]),
  ).buffer as ArrayBuffer;
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
