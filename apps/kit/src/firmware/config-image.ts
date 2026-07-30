const CONFIG_MAGIC = "ITERKIT1";
const CONFIG_HEADER_BYTES = 16;
const CONFIG_FIELD_HEADER_BYTES = 3;

export const DEVICE_CONFIGURATION_LIMITS = {
  wifiSsidBytes: 32,
  wifiPasswordBytes: 64,
  osBaseUrlBytes: 128,
  projectIdBytes: 64,
  projectApiKeyBytes: 128,
} as const;

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

const enum ConfigurationField {
  WifiSsid = 1,
  WifiPassword = 2,
  OsBaseUrl = 3,
  ProjectId = 4,
  ProjectApiKey = 5,
}

const configurationFieldNames = new Map<ConfigurationField, string>([
  [ConfigurationField.WifiSsid, "Wi-Fi network name"],
  [ConfigurationField.WifiPassword, "Wi-Fi password"],
  [ConfigurationField.OsBaseUrl, "OS base URL"],
  [ConfigurationField.ProjectId, "Iterate project ID"],
  [ConfigurationField.ProjectApiKey, "Iterate project API key"],
]);

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
 *   8..11  little-endian TLV payload byte length
 *   12..15 little-endian CRC-32 of the TLV payload
 *   16..   repeated [u8 tag, u16 little-endian length, UTF-8 value],
 *           then 0xff padding to the declared partition size
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
  if (configuration.schemaVersion !== 1) {
    throw new Error(`Unsupported device configuration schema ${configuration.schemaVersion}.`);
  }
  if (!configuration.iterate.projectId.startsWith("prj_")) {
    throw new Error("Iterate project ID must start with prj_.");
  }

  const baseUrl = normalizeOsBaseUrl(configuration.iterate.baseUrl);
  const fields = [
    encodeConfigurationField(
      ConfigurationField.WifiSsid,
      configuration.wifi.ssid,
      DEVICE_CONFIGURATION_LIMITS.wifiSsidBytes,
      "Wi-Fi network name",
      false,
    ),
    encodeConfigurationField(
      ConfigurationField.WifiPassword,
      configuration.wifi.password,
      DEVICE_CONFIGURATION_LIMITS.wifiPasswordBytes,
      "Wi-Fi password",
      true,
    ),
    encodeConfigurationField(
      ConfigurationField.OsBaseUrl,
      baseUrl,
      DEVICE_CONFIGURATION_LIMITS.osBaseUrlBytes,
      "OS base URL",
      false,
    ),
    encodeConfigurationField(
      ConfigurationField.ProjectId,
      configuration.iterate.projectId,
      DEVICE_CONFIGURATION_LIMITS.projectIdBytes,
      "Iterate project ID",
      false,
    ),
    encodeConfigurationField(
      ConfigurationField.ProjectApiKey,
      configuration.iterate.projectApiKey,
      DEVICE_CONFIGURATION_LIMITS.projectApiKeyBytes,
      "Iterate project API key",
      false,
    ),
  ];
  const payload = new Uint8Array(fields.reduce((length, field) => length + field.byteLength, 0));
  let payloadOffset = 0;
  for (const field of fields) {
    payload.set(field, payloadOffset);
    payloadOffset += field.byteLength;
  }
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
 * Decode an existing provisioning partition for local, physically connected
 * test rigs. Callers must continue to treat the returned password and project
 * key as secrets: this function deliberately never logs either value.
 */
export function decodeDeviceConfiguration(image: Uint8Array): DeviceConfiguration {
  if (image.byteLength < CONFIG_HEADER_BYTES) {
    throw new Error("Device configuration image is truncated.");
  }
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  if (textDecoder.decode(image.slice(0, CONFIG_MAGIC.length)) !== CONFIG_MAGIC) {
    throw new Error("Device configuration has invalid magic or version.");
  }

  const header = new DataView(image.buffer, image.byteOffset, CONFIG_HEADER_BYTES);
  const payloadLength = header.getUint32(8, true);
  if (payloadLength > image.byteLength - CONFIG_HEADER_BYTES) {
    throw new Error("Device configuration payload is truncated.");
  }
  const payload = image.slice(CONFIG_HEADER_BYTES, CONFIG_HEADER_BYTES + payloadLength);
  if (crc32(payload) !== header.getUint32(12, true)) {
    throw new Error("Device configuration checksum does not match.");
  }

  const fields = new Map<ConfigurationField, string>();
  for (let offset = 0; offset < payload.byteLength; ) {
    if (payload.byteLength - offset < CONFIG_FIELD_HEADER_BYTES) {
      throw new Error("Device configuration contains a malformed field.");
    }
    const tag = payload[offset] as ConfigurationField;
    const fieldLength = new DataView(payload.buffer, payload.byteOffset + offset + 1, 2).getUint16(
      0,
      true,
    );
    offset += CONFIG_FIELD_HEADER_BYTES;
    if (fieldLength > payload.byteLength - offset) {
      throw new Error("Device configuration contains a malformed field.");
    }
    const fieldName = configurationFieldNames.get(tag);
    const encoded = payload.slice(offset, offset + fieldLength);
    offset += fieldLength;
    if (!fieldName) continue;
    if (fields.has(tag)) {
      throw new Error(`Device configuration contains a duplicate ${fieldName} field.`);
    }
    let value: string;
    try {
      value = textDecoder.decode(encoded);
    } catch {
      throw new Error(`Device configuration ${fieldName} is not valid UTF-8.`);
    }
    if (value.includes("\0")) {
      throw new Error(`Device configuration ${fieldName} contains a NUL byte.`);
    }
    if (value.length === 0 && tag !== ConfigurationField.WifiPassword) {
      throw new Error(`Device configuration ${fieldName} must not be empty.`);
    }
    fields.set(tag, value);
  }

  for (const [tag, fieldName] of configurationFieldNames) {
    if (!fields.has(tag)) {
      throw new Error(`Device configuration is missing the ${fieldName} field.`);
    }
  }
  const baseUrl = normalizeOsBaseUrl(
    requiredConfigurationField(fields, ConfigurationField.OsBaseUrl),
  );
  const projectId = requiredConfigurationField(fields, ConfigurationField.ProjectId);
  if (!/^prj_[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error("Device configuration Iterate project ID is invalid.");
  }

  return {
    schemaVersion: 1,
    wifi: {
      ssid: requiredConfigurationField(fields, ConfigurationField.WifiSsid),
      password: requiredConfigurationField(fields, ConfigurationField.WifiPassword),
    },
    iterate: {
      baseUrl,
      projectId,
      projectApiKey: requiredConfigurationField(fields, ConfigurationField.ProjectApiKey),
    },
  };
}

function requiredConfigurationField(
  fields: ReadonlyMap<ConfigurationField, string>,
  tag: ConfigurationField,
) {
  const value = fields.get(tag);
  if (value === undefined) {
    throw new Error("Required device configuration field was lost.");
  }
  return value;
}

function encodeConfigurationField(
  tag: ConfigurationField,
  value: string,
  maximumBytes: number,
  label: string,
  allowEmpty: boolean,
) {
  const encoded = new TextEncoder().encode(value);
  if ((!allowEmpty && encoded.byteLength === 0) || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes.`);
  }
  if (encoded.byteLength > maximumBytes) {
    throw new Error(`${label} is ${encoded.byteLength} bytes; the device allows ${maximumBytes}.`);
  }

  const field = new Uint8Array(CONFIG_FIELD_HEADER_BYTES + encoded.byteLength);
  field[0] = tag;
  new DataView(field.buffer).setUint16(1, encoded.byteLength, true);
  field.set(encoded, CONFIG_FIELD_HEADER_BYTES);
  return field;
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
