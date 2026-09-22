import { inflate } from "pako";
import { z } from "zod";

const PixelFormat = z.enum(["mono1", "gray4", "rgb565"]);
export const ScreenInfo = z
  .object({
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    formats: z.array(PixelFormat).min(1).max(3),
    preferredFormat: PixelFormat,
    maxChunkBytes: z.number().int().min(1).max(4096),
    refreshTimeoutMs: z.number().int().min(1).max(60000),
    partialRefresh: z.boolean(),
  })
  .refine(
    (info) => info.formats.includes(info.preferredFormat),
    "Preferred format must be supported",
  )
  .refine(
    (info) =>
      info.formats.every(
        (format) =>
          Math.ceil((info.width * (format === "mono1" ? 1 : format === "gray4" ? 4 : 16)) / 8) *
            info.height <=
          1048576,
      ),
    "Screen frame exceeds 1 MiB",
  );

export const ScreenImageInput = z.object({
  device: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  image: z
    .object({ html: z.string().min(1).max(24000), format: PixelFormat.optional() })
    .nullable(),
});
export const ScreenStatus = z.object({
  uploadId: z.number().int().min(0).max(0xffffffff),
  state: z.enum(["idle", "receiving", "pending", "shown", "failed"]),
});

function pngU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

type RgbImage = { width: number; height: number; pixels: Uint8Array; channels: 3 | 4 };

/** Decode exactly the non-interlaced 8-bit RGB/RGBA PNG Browser Run emits.
 * Parsing it here keeps image codecs, allocation and dithering off the ESP32. */
function browserPng(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): RgbImage {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || signature.some((byte, i) => bytes[i] !== byte)) {
    throw new Error("Browser Run did not return a PNG");
  }
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const compressed: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = pngU32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("PNG chunk is truncated");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, dataStart));
    if (type === "IHDR") {
      if (length !== 13) throw new Error("PNG header has an invalid length");
      width = pngU32(bytes, dataStart);
      height = pngU32(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colourType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (
        bitDepth !== 8 ||
        (colourType !== 2 && colourType !== 6) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("PNG must be non-interlaced 8-bit RGB or RGBA");
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      compressed.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width !== expectedWidth || height !== expectedHeight || compressed.length === 0) {
    throw new Error("Browser screenshot dimensions do not match the device");
  }
  const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of compressed) {
    joined.set(part, cursor);
    cursor += part.length;
  }
  const stride = width * channels;
  const filtered = inflate(joined);
  if (filtered.length !== height * (stride + 1))
    throw new Error("PNG pixels have an invalid length");
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const source = y * (stride + 1);
    const destination = y * stride;
    const filter = filtered[source]!;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[source + 1 + x]!;
      const left = x >= channels ? pixels[destination + x - channels]! : 0;
      const up = y > 0 ? pixels[destination - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[destination - stride + x - channels]! : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = (raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else if (filter !== 0) {
        throw new Error("PNG uses an unsupported row filter");
      }
      pixels[destination + x] = value;
    }
  }
  return { width, height, pixels, channels };
}

/** Server-side colour conversion; no PNG decoder or dither loop on the board.
 * Every row starts at a byte boundary, including widths not divisible by 8. */
export function renderScreenPixels(
  png: Uint8Array,
  info: z.infer<typeof ScreenInfo>,
  format: z.infer<typeof PixelFormat>,
) {
  const image = browserPng(png, info.width, info.height);
  const bits = format === "mono1" ? 1 : format === "gray4" ? 4 : 16;
  const stride = Math.ceil((image.width * bits) / 8);
  const bitmap = new Uint8Array(stride * image.height);
  const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * image.channels;
      const alpha = image.channels === 4 ? image.pixels[i + 3]! / 255 : 1;
      const r = Math.round(image.pixels[i]! * alpha + 255 * (1 - alpha));
      const g = Math.round(image.pixels[i + 1]! * alpha + 255 * (1 - alpha));
      const b = Math.round(image.pixels[i + 2]! * alpha + 255 * (1 - alpha));
      const luminance = (r * 77 + g * 150 + b * 29) >> 8;
      if (format === "mono1") {
        const threshold = bayer4[(y % 4) * 4 + (x % 4)]! * 16 + 8;
        if (luminance < threshold) bitmap[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
      } else if (format === "gray4") {
        bitmap[y * stride + (x >> 1)]! |= Math.round(luminance / 17) << (x % 2 ? 0 : 4);
      } else {
        const pixel = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        bitmap[y * stride + x * 2] = pixel >> 8;
        bitmap[y * stride + x * 2 + 1] = pixel & 255;
      }
    }
  }
  return bitmap;
}
