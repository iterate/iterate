const CONFIG_MAGIC = "ITERKIT1";
const CONFIG_HEADER_BYTES = 16;

/**
 * Field tags, matching `configuration.c` in the firmware exactly.
 *
 * These numbers ARE the wire format. 1-5 are required — the firmware fails
 * closed on a partition missing any of them — and everything above is
 * forward-compatible: its decoder skips unknown length-delimited tags so a
 * newer flash tool can provision a field an older build has never heard of.
 */
const FIELD_WIFI_SSID = 1;
const FIELD_WIFI_PASSWORD = 2;
const FIELD_OS_BASE_URL = 3;
const FIELD_PROJECT_ID = 4;
const FIELD_PROJECT_API_KEY = 5;
const FIELD_DEVICE_ID = 6;
const FIELD_KIT_PATH = 7;

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
    /**
     * Which device this is, and where it mounts itself — both optional
     * because current firmware hardcodes them per board and skips these
     * tags. Provisioning them now means a partition written today already
     * carries the answer when the firmware learns to ask.
     */
    deviceId?: string;
    kitPath?: string;
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
 *   8..11  little-endian payload byte length
 *   12..15 little-endian CRC-32 of the payload bytes
 *   16..   tag-length-value fields, then 0xff padding to the partition size
 *
 * Each field is `u8 tag | u16 little-endian length | length bytes` of UTF-8,
 * with no terminator: the length is the only delimiter, which is what lets the
 * firmware skip a tag it does not know.
 *
 * THIS IS NOT JSON, and it used to be. The firmware has only ever had a
 * tag-length-value decoder, so every partition this function produced was
 * rejected before a single credential was read — browser flashing could not
 * have worked, and the two devices proven on hardware were provisioned by a
 * hand-built image instead. The lesson is in the shape of the bug: an encoder
 * and a decoder that never met in a test agree on nothing but the magic
 * number, which is exactly the part that made the output look right.
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
  const payload = encodeFields(
    [
      [FIELD_WIFI_SSID, configuration.wifi.ssid],
      [FIELD_WIFI_PASSWORD, configuration.wifi.password],
      [FIELD_OS_BASE_URL, configuration.iterate.baseUrl],
      [FIELD_PROJECT_ID, configuration.iterate.projectSlug],
      [FIELD_PROJECT_API_KEY, configuration.iterate.projectApiKey],
      [FIELD_DEVICE_ID, configuration.iterate.deviceId],
      [FIELD_KIT_PATH, configuration.iterate.kitPath],
    ],
    textEncoder,
  );
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

/**
 * Lay out the tag-length-value payload, skipping fields with no value.
 *
 * A field is omitted rather than written empty because the firmware treats an
 * empty required field as a fault, and an omitted optional one as absent —
 * those are different answers and only one of them is true.
 */
function encodeFields(fields: readonly [number, string | undefined][], textEncoder: TextEncoder) {
  const encoded = fields.flatMap(([tag, value]) => {
    if (value === undefined || value.length === 0) return [];
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > 0xffff) {
      throw new Error(`Configuration field ${tag} is longer than the format allows.`);
    }
    return [{ tag, bytes }];
  });

  const payload = new Uint8Array(
    encoded.reduce((total, field) => total + 3 + field.bytes.byteLength, 0),
  );
  let offset = 0;
  for (const field of encoded) {
    payload[offset] = field.tag;
    // Little-endian, like every other multi-byte value in this format.
    payload[offset + 1] = field.bytes.byteLength & 0xff;
    payload[offset + 2] = (field.bytes.byteLength >>> 8) & 0xff;
    payload.set(field.bytes, offset + 3);
    offset += 3 + field.bytes.byteLength;
  }
  return payload;
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
