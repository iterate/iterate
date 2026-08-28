import { expect, test } from "vitest";
import { photoFrame, photoFrameMaxWidth } from "./photo-layout.ts";

const bubble = { maxHeight: 340, maxWidth: 280 };

test("the frame width is also the bubble's cap, so a caption cannot outgrow the photo", () => {
  // A big phone: the 280 ceiling wins. A small one: 72% of the screen.
  expect(photoFrameMaxWidth(430)).toBe(280);
  expect(photoFrameMaxWidth(390)).toBe(280);
  expect(photoFrameMaxWidth(320)).toBe(230);
});

test("a landscape photo fills the bubble width at its own aspect ratio", () => {
  expect(photoFrame({ ...bubble, natural: { height: 1080, width: 1920 } })).toEqual({
    backdrop: false,
    height: 158,
    width: 280,
  });
});

test("a phone screenshot is capped in height and gets the blurred backdrop", () => {
  // 1179×2556 at full bubble width would be 607px tall — most of a phone
  // screen for one message. Capped, the photo no longer fills the frame's
  // width, which is exactly when the backdrop has something to do.
  expect(photoFrame({ ...bubble, natural: { height: 2556, width: 1179 } })).toEqual({
    backdrop: true,
    height: 340,
    width: 280,
  });
});

test("a photo shorter than the cap needs no backdrop even when it is portrait", () => {
  expect(photoFrame({ ...bubble, natural: { height: 350, width: 300 } })).toMatchObject({
    backdrop: false,
    height: 327,
    width: 280,
  });
});

test("a small image keeps its own size, and the backdrop fills the frame around it", () => {
  // Never scaled up — an 80px sticker stays 80px — but the frame is still the
  // bubble's width, so the bubble hugs nothing and the photo stays flush.
  expect(photoFrame({ ...bubble, natural: { height: 80, width: 80 } })).toEqual({
    backdrop: true,
    height: 80,
    width: 280,
  });
});

test("an unmeasured photo holds a plain box so the thread does not jump", () => {
  expect(photoFrame({ ...bubble, natural: undefined })).toEqual({
    backdrop: false,
    height: 210,
    width: 280,
  });
  // A degenerate size from the image loader is the same situation.
  expect(photoFrame({ ...bubble, natural: { height: 0, width: 0 } })).toMatchObject({
    height: 210,
  });
});
