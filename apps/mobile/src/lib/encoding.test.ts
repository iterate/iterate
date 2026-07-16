import { expect, test } from "vitest";
import { base64ToUint8Array } from "./encoding.ts";

test("decodes base64 into the exact bytes", () => {
  // A 1x1 transparent PNG — the same fixture shape the e2e uploads.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const bytes = base64ToUint8Array(png);
  // PNG magic number proves a faithful binary round-trip.
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.length).toBe(Math.floor((png.length * 3) / 4) - 2); // two padding '='
});

test("tolerates whitespace/newlines in base64 input", () => {
  expect([...base64ToUint8Array("aGVs\nbG8=")]).toEqual([104, 101, 108, 108, 111]);
});
