const DEVICE_PUSH_ALGORITHM = "AES-GCM-SHA256+DEVICE-PUSH-V1" as const;

export type DevicePushTokenBinding = {
  offset: number;
  ownerId: string;
  path: string;
  projectId: string;
};

export type EncryptedDevicePushToken = {
  algorithm: typeof DEVICE_PUSH_ALGORITHM;
  ciphertext: string;
  iv: string;
};

export async function encryptDevicePushToken(
  token: string,
  keyMaterial: string,
  binding: DevicePushTokenBinding,
): Promise<EncryptedDevicePushToken> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importDeviceKey(keyMaterial);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(binding) },
    key,
    new TextEncoder().encode(token),
  );
  return {
    algorithm: DEVICE_PUSH_ALGORITHM,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptDevicePushToken(
  encrypted: EncryptedDevicePushToken,
  keyMaterial: string,
  binding: DevicePushTokenBinding,
): Promise<string> {
  const key = await importDeviceKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToArrayBuffer(encrypted.iv),
      additionalData: additionalData(binding),
    },
    key,
    base64ToArrayBuffer(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function additionalData(binding: DevicePushTokenBinding): ArrayBuffer {
  return new TextEncoder().encode(
    JSON.stringify([
      "iterate-device-push-token",
      1,
      binding.projectId,
      binding.path,
      binding.ownerId,
      binding.offset,
    ]),
  ).buffer as ArrayBuffer;
}

async function importDeviceKey(keyMaterial: string): Promise<CryptoKey> {
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
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}
