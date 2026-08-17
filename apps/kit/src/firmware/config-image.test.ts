import { describe, expect, it } from "vitest";
import {
  crc32,
  encodeDeviceConfiguration,
  normalizeOsBaseUrl,
  type DeviceConfiguration,
} from "./config-image.ts";

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "correct horse battery staple" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectSlug: "voice-lab",
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
  it("writes the documented header, payload, checksum, and erased padding", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    const header = new DataView(image.buffer);
    const payloadLength = header.getUint32(8, true);
    const payload = image.slice(16, 16 + payloadLength);

    expect(new TextDecoder().decode(image.slice(0, 8))).toBe("ITERKIT1");
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(configuration);
    expect(header.getUint32(12, true)).toBe(crc32(payload));
    expect(image.slice(16 + payloadLength).every((byte) => byte === 0xff)).toBe(true);
  });

  it("rejects a payload larger than the firmware's declared partition", () => {
    expect(() => encodeDeviceConfiguration(configuration, 32)).toThrow("the partition allows");
  });
});
