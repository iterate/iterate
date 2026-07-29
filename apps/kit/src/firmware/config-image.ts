const CONFIG_MAGIC = "ITERKIT1";
const CONFIG_HEADER_BYTES = 16;

export interface DeviceConfiguration {
  schemaVersion: 1;
  wifi: {
    ssid: string;
    password: string;
  };
  iterate: {
    baseUrl: string;
    projectSlug: string;
    projectApiKey: string;
  };
}

export function normalizeOsBaseUrl(value: string) {
  const trimmed = value.trim();
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OS base host must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("OS base host must be an origin without a path, credentials, or query.");
  }
  return url.origin;
}

/**
 * Encode the provisioned values into the raw partition consumed by
 * Iterate-aware firmware:
 *
 *   0..7   ASCII "ITERKIT1"
 *   8..11  little-endian JSON byte length
 *   12..15 little-endian CRC-32 of the JSON bytes
 *   16..   UTF-8 JSON, then 0xff padding to the declared partition size
 */
export function encodeDeviceConfiguration(
  configuration: DeviceConfiguration,
  partitionSize: number,
) {
  if (!Number.isSafeInteger(partitionSize) || partitionSize <= CONFIG_HEADER_BYTES) {
    throw new Error(`Invalid configuration partition size ${partitionSize}.`);
  }

  const textEncoder = new TextEncoder();
  const magic = textEncoder.encode(CONFIG_MAGIC);
  const payload = textEncoder.encode(JSON.stringify(configuration));
  if (payload.byteLength > partitionSize - CONFIG_HEADER_BYTES) {
    throw new Error(
      `Device configuration is ${payload.byteLength} bytes; the partition allows ${partitionSize - CONFIG_HEADER_BYTES}.`,
    );
  }

  const image = new Uint8Array(partitionSize);
  image.fill(0xff);
  image.set(magic, 0);
  const header = new DataView(image.buffer, 0, CONFIG_HEADER_BYTES);
  header.setUint32(8, payload.byteLength, true);
  header.setUint32(12, crc32(payload), true);
  image.set(payload, CONFIG_HEADER_BYTES);
  return image;
}

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
