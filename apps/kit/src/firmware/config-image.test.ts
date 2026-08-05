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

/**
 * Read the image back the way `configuration.c` reads it.
 *
 * Deliberately a second implementation rather than a helper shared with the
 * encoder: the defect this guards against was an encoder and a decoder that
 * agreed only on the magic number, and a round trip through the encoder's own
 * idea of the format would have passed all the way through that.
 */
function decodeLikeFirmware(image: Uint8Array) {
  const header = new DataView(image.buffer, image.byteOffset, 16);
  if (new TextDecoder().decode(image.slice(0, 8)) !== "ITERKIT1") {
    throw new Error("bad magic");
  }
  const payloadLength = header.getUint32(8, true);
  const payload = image.slice(16, 16 + payloadLength);
  if (header.getUint32(12, true) !== crc32(payload)) throw new Error("bad checksum");

  const fields = new Map<number, string>();
  let offset = 0;
  while (offset < payload.byteLength) {
    if (payload.byteLength - offset < 3) throw new Error("truncated field header");
    const tag = payload[offset]!;
    const length = payload[offset + 1]! | (payload[offset + 2]! << 8);
    offset += 3;
    if (length > payload.byteLength - offset) throw new Error("truncated field value");
    if (fields.has(tag)) throw new Error(`duplicate field ${tag}`);
    fields.set(tag, new TextDecoder().decode(payload.slice(offset, offset + length)));
    offset += length;
  }
  return fields;
}

describe("encodeDeviceConfiguration", () => {
  it("writes fields the firmware's own decoder accepts", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    const fields = decodeLikeFirmware(image);

    expect(fields.get(1)).toBe("studio");
    expect(fields.get(2)).toBe("correct horse battery staple");
    expect(fields.get(3)).toBe("https://os.iterate.com");
    expect(fields.get(4)).toBe("voice-lab");
    expect(fields.get(5)).toBe("itxk_secret");
    // Every field the firmware requires, and nothing it would reject.
    expect([...fields.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("provisions the forward fields when they are supplied", () => {
    const fields = decodeLikeFirmware(
      encodeDeviceConfiguration(
        {
          ...configuration,
          iterate: { ...configuration.iterate, deviceId: "sc-01", kitPath: "kit.stackchan" },
        },
        512,
      ),
    );
    expect(fields.get(6)).toBe("sc-01");
    expect(fields.get(7)).toBe("kit.stackchan");
  });

  it("pads the rest of the partition as erased flash", () => {
    const image = encodeDeviceConfiguration(configuration, 512);
    const payloadLength = new DataView(image.buffer, image.byteOffset, 16).getUint32(8, true);
    expect(image.slice(16 + payloadLength).every((byte) => byte === 0xff)).toBe(true);
  });

  it("encodes non-ASCII credentials by byte length, not character count", () => {
    const fields = decodeLikeFirmware(
      encodeDeviceConfiguration(
        { ...configuration, wifi: { ...configuration.wifi, ssid: "café–studio" } },
        512,
      ),
    );
    expect(fields.get(1)).toBe("café–studio");
  });

  it("rejects a payload larger than the firmware's declared partition", () => {
    expect(() => encodeDeviceConfiguration(configuration, 32)).toThrow("the partition allows");
  });
});
