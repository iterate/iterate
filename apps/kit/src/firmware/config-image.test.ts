import { describe, expect, it } from "vitest";
import {
  crc32,
  decodeDeviceConfiguration,
  encodeDeviceConfiguration,
  normalizeOsBaseUrl,
  type DeviceConfiguration,
} from "./config-image.ts";

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "correct horse battery staple" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectId: "prj_voice_lab",
    projectApiKey: "itxk_secret",
  },
};

describe("normalizeOsBaseUrl", () => {
  it("defaults a bare host to HTTPS", () => {
    expect(normalizeOsBaseUrl("os.iterate.com")).toBe("https://os.iterate.com");
  });

  it("preserves an explicit local HTTP origin", () => {
    expect(normalizeOsBaseUrl("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("rejects paths so the device cannot silently dial the wrong endpoint", () => {
    expect(() => normalizeOsBaseUrl("https://os.iterate.com/not-os")).toThrow("must be an origin");
  });
});

describe("encodeDeviceConfiguration", () => {
  it("writes the documented header, compact TLV payload, checksum, and erased padding", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    const header = new DataView(image.buffer);
    const payloadLength = header.getUint32(8, true);
    const payload = image.slice(16, 16 + payloadLength);

    expect(new TextDecoder().decode(image.slice(0, 8))).toBe("ITERKIT1");
    expect(Array.from(payload.slice(0, 3))).toEqual([1, 6, 0]);
    expect(new TextDecoder().decode(payload)).not.toContain("{");
    expect(header.getUint32(12, true)).toBe(crc32(payload));
    expect(image.slice(16 + payloadLength).every((byte) => byte === 0xff)).toBe(true);
  });

  it("rejects a payload larger than the firmware's declared partition", () => {
    expect(() => encodeDeviceConfiguration(configuration, 32)).toThrow("the partition allows");
  });
});

describe("decodeDeviceConfiguration", () => {
  it("round-trips the exact secret-bearing provisioning image", () => {
    const image = encodeDeviceConfiguration(configuration, 512);

    expect(decodeDeviceConfiguration(image)).toEqual(configuration);
  });

  it("rejects a corrupt image before returning any partial credentials", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    image[20] ^= 0x01;

    expect(() => decodeDeviceConfiguration(image)).toThrow(
      "checksum",
    );
  });

  it("rejects duplicate known fields instead of silently choosing one", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    const view = new DataView(image.buffer);
    const payloadLength = view.getUint32(8, true);
    const firstFieldLength = 3 + view.getUint16(17, true);
    const duplicate = image.slice(16, 16 + firstFieldLength);
    image.copyWithin(
      16 + firstFieldLength,
      16,
      16 + payloadLength,
    );
    image.set(duplicate, 16);
    view.setUint32(8, payloadLength + firstFieldLength, true);
    const payload = image.slice(
      16,
      16 + payloadLength + firstFieldLength,
    );
    view.setUint32(12, crc32(payload), true);

    expect(() => decodeDeviceConfiguration(image)).toThrow(
      "duplicate",
    );
  });
});
