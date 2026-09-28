import { expect, test } from "vitest";
import { offset } from "./config-image.ts";

/* One partition table per flash size (firmware/targets/common): the M5StickS3 has 8 MiB, every other
 * board 16 MiB. */
test.for([
  { name: "havpe", expected: "0x510000" },
  { name: "m5sticks3", expected: "0x210000" },
  { name: "satellite1", expected: "0x510000" },
  { name: "stackchan", expected: "0x510000" },
  { name: "waveshare_s3_amoled", expected: "0x510000" },
  { name: "waveshare_s3_rlcd", expected: "0x510000" },
  { name: "zectrix_note4", expected: "0x510000" },
])(
  "offset: $name's configuration partition is where its partition table puts it",
  ({ name, expected }) => {
    expect(offset(name)).toBe(expected);
  },
);

test("offset: a name that is no board target is refused with the boards' names", () => {
  expect(() => offset("mac")).toThrow(
    "mac is no board target; the boards are havpe, m5sticks3, satellite1, stackchan, waveshare_s3_amoled, waveshare_s3_rlcd, zectrix_note4.",
  );
});
