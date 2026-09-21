import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { ScreenInfo, renderScreenPixels } from "./screen.js";

function rgbaPng(width: number, height: number, rgba: number[]) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE(crc32(body), body.length + 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.slice(y * width * 4, (y + 1) * width * 4)).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const info = (width: number, height: number) =>
  ScreenInfo.parse({
    width,
    height,
    formats: ["mono1", "gray4", "rgb565"],
    preferredFormat: "mono1",
    maxChunkBytes: 4096,
    refreshTimeoutMs: 1000,
    partialRefresh: false,
  });

test("nine-pixel monochrome rows keep padding independent and composite alpha on white", () => {
  const pixels = Array.from({ length: 18 }, (_, i) =>
    i === 8 || i === 9 ? [0, 0, 0, 255] : [0, 0, 0, 0],
  ).flat();
  expect(renderScreenPixels(rgbaPng(9, 2, pixels), info(9, 2), "mono1")).toEqual(
    Uint8Array.of(0, 128, 128, 0),
  );
});
test("odd-width grayscale rows preserve sixteen levels and restart on a byte boundary", () => {
  const pixels = [0, 17, 255, 136, 170, 204].flatMap((n) => [n, n, n, 255]);
  expect(renderScreenPixels(rgbaPng(3, 2, pixels), info(3, 2), "gray4")).toEqual(
    Uint8Array.of(0x01, 0xf0, 0x8a, 0xc0),
  );
});
test("RGB565 preserves primary colours in big-endian wire order", () => {
  const pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
  expect(renderScreenPixels(rgbaPng(2, 2, pixels), info(2, 2), "rgb565")).toEqual(
    Uint8Array.of(0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff),
  );
});
test("a screenshot from a different viewport is rejected", () => {
  expect(() => renderScreenPixels(rgbaPng(1, 1, [0, 0, 0, 255]), info(2, 2), "mono1")).toThrow(
    "dimensions do not match",
  );
});
test("unbounded device metadata and unsupported preferred formats are rejected", () => {
  expect(() => ScreenInfo.parse({ ...info(1, 1), width: 2048, height: 2048 })).toThrow("1 MiB");
  expect(() =>
    ScreenInfo.parse({ ...info(1, 1), formats: ["mono1"], preferredFormat: "rgb565" }),
  ).toThrow("Preferred format");
});
