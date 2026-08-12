// What IS this image payload, really? iOS has handed the picker bytes whose
// `asset.mimeType` label doesn't match the actual encoding (prod failure:
// "toMarkdown failed for IMG_3732.heic: Unsupported file type" — the label
// said HEIC, the pipeline named the file .heic, and the server-side
// converter picks by extension). The magic bytes are the truth, so sniff
// them from the head of the base64 payload. Pure (no Expo imports) — vitest
// covers it in root CI.

import { base64ToUint8Array } from "./encoding.ts";

/** `ftyp` brands (bytes 8-11) the HEIC/HEIF container family uses. */
const HEIC_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
];

/**
 * Sniff the payload's content type from its magic bytes. Returns null when
 * the head matches nothing known — callers fall back to the picker's label.
 */
export function sniffImageContentType(base64: string): string | null {
  // 24 base64 chars decode to 18 bytes — enough for every signature below.
  // atob rejects lengths that aren't a multiple of 4, so trim the tail.
  const compact = base64.replace(/\s+/g, "").slice(0, 24);
  const head = compact.slice(0, compact.length - (compact.length % 4));
  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8Array(head);
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "image/png";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.includes(brand)) return "image/heic";
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/**
 * Non-null when the capture pipeline is guaranteed to choke on this payload
 * server-side — itx.ai.toMarkdown has no HEIC/AVIF converter — so the item
 * should fail on the phone with something actionable instead of uploading
 * bytes doomed to fail.
 */
export function unsupportedImageReason(contentType: string): string | null {
  if (!["image/heic", "image/heif", "image/avif"].includes(contentType)) return null;
  const label = (contentType.split("/")[1] || contentType).toUpperCase();
  return `This is a ${label} image, which the analyzer can't read. iOS normally converts photos on pick; if this keeps happening, set Settings → Camera → Formats to "Most Compatible", or export the photo as a JPEG and pick that.`;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
