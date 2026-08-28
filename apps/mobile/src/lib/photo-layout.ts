// How a photo sits in its chat bubble, Telegram-style.
//
// Two rules do all the work:
//
// 1. The bubble is the photo. The frame takes the photo's own aspect ratio up
//    to the widest a bubble may be, so the image reaches the bubble's edges
//    instead of floating inside padding with dead space around it.
// 2. A phone screenshot is far too tall to show whole, so the frame's height
//    is capped. Past the cap the photo is fitted inside the frame instead of
//    cropped — it ends up narrower than the frame, and the caller fills what
//    is left with a blurred, cover-scaled copy of the same photo rather than
//    black bars.

/** The frame a photo is drawn into, and whether it needs the blurred backdrop. */
export type PhotoFrame = {
  /** True when the photo is narrower than its frame, so something has to fill
   * the sides — a blurred copy of the photo itself. */
  backdrop: boolean;
  height: number;
  width: number;
};

export function photoFrame(input: {
  maxHeight: number;
  maxWidth: number;
  /** The photo's pixel dimensions, or undefined while they are still being
   * measured. */
  natural: { height: number; width: number } | undefined;
}): PhotoFrame {
  const natural = input.natural;
  // Nothing measured yet: hold a plain 4:3 box so the thread does not reflow
  // around a zero-height row and then jump.
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { backdrop: false, height: Math.round(input.maxWidth * 0.75), width: input.maxWidth };
  }
  // Small images keep their own size rather than being blown up to bubble
  // width — an 80px sticker should look like an 80px sticker.
  const width = Math.min(input.maxWidth, natural.width);
  const height = (natural.height * width) / natural.width;
  if (height <= input.maxHeight) {
    return { backdrop: false, height: Math.round(height), width: Math.round(width) };
  }
  return { backdrop: true, height: input.maxHeight, width: Math.round(width) };
}
