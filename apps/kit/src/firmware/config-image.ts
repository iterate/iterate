const CONFIG_MAGIC = "ITERKIT1";
const CONFIG_HEADER_BYTES = 16;

/**
 * Field tags, matching `configuration.c` in the firmware exactly.
 *
 * These numbers are the wire format. All five are required by the firmware.
 */
const fieldWifiSsid = 1;
const fieldWifiPassword = 2;
const fieldOsBaseUrl = 3;
const fieldProjectId = 4;
const fieldProjectApiKey = 5;

/* These include the C string terminator: configuration.h is the ABI source. */
const wifiSsidMaxBytes = 32;
const wifiPasswordMaxBytes = 64;
const osBaseUrlMaxBytes = 128;
const projectIdMaxBytes = 64;
const projectApiKeyMaxBytes = 128;

export interface DeviceConfiguration {
  schemaVersion: 1;
  wifi: {
    ssid: string;
    password: string;
  };
  iterate: {
    baseUrl: string;
    projectId: string;
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
 *   8..11  little-endian payload byte length
 *   12..15 little-endian CRC-32 of the payload bytes
 *   16..   tag-length-value fields, then 0xff padding to the partition size
 *
 * Each field is `u8 tag | u16 little-endian length | length bytes` of UTF-8,
 * with no terminator: the length is the only delimiter, which is what lets the
 * firmware skip a tag it does not know.
 *
 * The installed firmware supports one active configuration: replacing this
 * partition replaces that device's Wi-Fi and project identity.
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
      {
        tag: fieldWifiSsid,
        name: "Wi-Fi SSID",
        value: configuration.wifi.ssid,
        maxBytes: wifiSsidMaxBytes,
      },
      /*
       * ALWAYS WRITTEN, EVEN EMPTY. An open network has no password, and the
       * firmware is built for exactly that: the password is the one field it
       * decodes with `allow_empty`, while still requiring the tag to be
       * present. Omitting it — as skipping empty values would — makes an open
       * SSID unprovisionable with a "missing field" fault.
       */
      {
        tag: fieldWifiPassword,
        name: "Wi-Fi password",
        value: configuration.wifi.password,
        mayBeEmpty: true,
        maxBytes: wifiPasswordMaxBytes,
        validate: (value, bytes) =>
          bytes.byteLength === 0 ||
          (bytes.byteLength >= 8 && bytes.byteLength <= 63) ||
          (bytes.byteLength === 64 && /^[0-9a-fA-F]+$/.test(value)),
      },
      {
        tag: fieldOsBaseUrl,
        name: "OS base URL",
        value: normalizeOsBaseUrl(configuration.iterate.baseUrl),
        maxBytes: osBaseUrlMaxBytes,
      },
      {
        tag: fieldProjectId,
        name: "project id",
        value: configuration.iterate.projectId,
        maxBytes: projectIdMaxBytes,
        validate: (value) => /^prj_[A-Za-z0-9_-]+$/.test(value),
      },
      {
        tag: fieldProjectApiKey,
        name: "project API key",
        value: configuration.iterate.projectApiKey,
        maxBytes: projectApiKeyMaxBytes,
      },
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

/** One field on its way into the partition. */
interface ConfigurationField {
  tag: number;
  /** Human name, so a rejected value names itself in the error. */
  name: string;
  value: string;
  /** True only for the Wi-Fi password; see the call site. */
  mayBeEmpty?: boolean;
  /** Firmware destination capacity less its NUL terminator. */
  maxBytes?: number;
  /** Firmware policy beyond the container's structural validation. */
  validate?: (value: string, bytes: Uint8Array) => boolean;
}

/**
 * Lay out the tag-length-value payload.
 *
 * Required empty fields throw here, before a device can reject the completed
 * partition at boot with an unhelpful missing-field fault.
 */
function encodeFields(fields: readonly ConfigurationField[], textEncoder: TextEncoder) {
  const encoded = fields.flatMap((field) => {
    if (field.value.length === 0 && field.mayBeEmpty !== true) {
      throw new Error(`Device configuration is missing its ${field.name}.`);
    }
    const bytes = textEncoder.encode(field.value);
    if (bytes.includes(0)) {
      throw new Error(`Device configuration ${field.name} cannot contain a NUL character.`);
    }
    if (field.maxBytes !== undefined && bytes.byteLength > field.maxBytes) {
      throw new Error(`Device configuration ${field.name} is longer than firmware allows.`);
    }
    if (field.validate && !field.validate(field.value, bytes)) {
      throw new Error(`Device configuration has an invalid ${field.name}.`);
    }
    if (bytes.byteLength > 0xffff) {
      throw new Error(`Configuration field ${field.tag} is longer than the format allows.`);
    }
    return [{ tag: field.tag, bytes }];
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
