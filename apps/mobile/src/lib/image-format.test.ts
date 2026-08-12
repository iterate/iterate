import { expect, test } from "vitest";
import { sniffImageContentType, unsupportedImageReason } from "./image-format.ts";

test("sniffs the real encoding from magic bytes, whatever the label said", () => {
  expect(sniffImageContentType(payload([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
  expect(sniffImageContentType(payload([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
    "image/png",
  );
  expect(sniffImageContentType(payload(text("GIF89a")))).toBe("image/gif");
  expect(sniffImageContentType(payload([...text("RIFF"), 0x24, 0, 0, 0, ...text("WEBP")]))).toBe(
    "image/webp",
  );
});

test("recognizes the HEIC/AVIF ftyp container family", () => {
  // ftyp box: 4-byte length, "ftyp", then the brand.
  const ftyp = (brand: string) => payload([0, 0, 0, 0x18, ...text("ftyp"), ...text(brand)]);
  expect(sniffImageContentType(ftyp("heic"))).toBe("image/heic");
  expect(sniffImageContentType(ftyp("mif1"))).toBe("image/heic");
  expect(sniffImageContentType(ftyp("avif"))).toBe("image/avif");
});

test("unknown or too-short payloads sniff to null (callers fall back to the label)", () => {
  expect(sniffImageContentType(payload(text("hello world, not an image")))).toBe(null);
  expect(sniffImageContentType(btoa("\xff\xd8"))).toBe(null); // 2 bytes: not enough to be sure
  expect(sniffImageContentType("")).toBe(null);
  expect(sniffImageContentType("!!!not base64!!!")).toBe(null);
});

test("whitespace in the base64 stream does not break sniffing", () => {
  const jpeg = payload([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(sniffImageContentType(`${jpeg.slice(0, 6)}\n${jpeg.slice(6)}`)).toBe("image/jpeg");
});

test("unsupportedImageReason blocks only the formats the server cannot convert", () => {
  expect(unsupportedImageReason("image/heic")).toMatch(/HEIC.*Most Compatible/s);
  expect(unsupportedImageReason("image/avif")).toMatch(/AVIF/);
  expect(unsupportedImageReason("image/jpeg")).toBe(null);
  expect(unsupportedImageReason("image/png")).toBe(null);
});

// --- helpers ---------------------------------------------------------------

/** Bytes (zero-padded past every signature's reach) → base64, like the picker's. */
function payload(bytes: number[]): string {
  const padded = [...bytes, ...new Array(Math.max(0, 20 - bytes.length)).fill(0)];
  return btoa(String.fromCharCode(...padded));
}

function text(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0));
}
