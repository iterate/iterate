// How a photo sits in its chat bubble, Telegram-style.
//
// Three rules do all the work:
//
// 1. The frame is always the full bubble width. That is what makes a photo
//    reach the bubble's edges instead of floating inside padding — and it is
//    why the bubble a photo lives in is capped at the same width (a caption
//    wide enough to stretch the bubble would reopen the gap at the photo's
//    edge).
// 2. The photo is never scaled up. A small image stays its own size rather
//    than being blown up to bubble width and going soft.
// 3. A phone screenshot is far too tall to show whole, so the frame's height
//    is capped. Past the cap the photo is fitted rather than cropped.
//
// Rules 2 and 3 both leave the photo narrower than its frame; the caller
// fills what is left with a blurred, cover-scaled copy of the same photo
// rather than black bars.

/** The widest a photo frame — and so the widest a bubble carrying one — goes
 * on a screen this wide. */
export function photoFrameMaxWidth(windowWidth: number): number {
  return Math.min(280, Math.round(windowWidth * 0.72));
}

/** The tallest any photo gets: one message should not take a whole screen. */
export const PHOTO_MAX_HEIGHT = 340;

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
  // Fit inside the frame, and never past 1:1 — the photo may end up narrower
  // than the frame from either constraint, and the backdrop covers both.
  const scale = Math.min(input.maxWidth / natural.width, input.maxHeight / natural.height, 1);
  return {
    backdrop: natural.width * scale < input.maxWidth,
    height: Math.round(natural.height * scale),
    width: input.maxWidth,
  };
}
