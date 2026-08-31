// The 2020-era Zoom filters. Each filter is a plain draw function over
// (canvas ctx, current video frame, face geometry, tap-cycled background
// index) — deliberately data-shaped so a later PR can load agent-written
// filters from userland streams through this same interface.
//
// ONLY import this module from the filter-camera DOM component (and its
// test harness): the generated image imports below are megabytes that must
// not ride into the native Hermes bundle. The native picker reads picker.ts.
//
// Backdrops and flashcard pictures are AI-generated or stock images (the
// scripts/generate-*.mjs scripts, committed as data URIs); face art is
// emoji. The "real eyes and lips" effect samples the live video through
// cutouts whose shape IS your tracked feature's landmark ring (feathered,
// user-adjustable looseness) — drawn in place (a mask following your face),
// remapped onto a character (the buried potato), or pinned to a screen
// region (the flashcards keep your face in the top half).

import { FILTER_BACKDROPS } from "./backdrops.generated.ts";
import { FLASHCARD_IMAGES_CARTOON } from "./flashcards-cartoon.generated.ts";
import { FLASHCARD_IMAGES_ENCYCLOPAEDIA } from "./flashcards-encyclopaedia.generated.ts";
import { FLASHCARD_IMAGES_PHOTO } from "./flashcards-photo.generated.ts";
import { FILTER_PICKER } from "./picker.ts";
import type { FaceFeature, FaceGeometry } from "./face-geometry.ts";

/** How loose the cutout masks are around the tracked features, per feature
 * kind — 1 is the default; the pipeline lets the user drag these. */
export type MaskStretch = { eyes: { x: number; y: number }; lips: { x: number; y: number } };

export type FeatureHit = { kind: keyof MaskStretch; cx: number; cy: number; radius: number };

export type FilterFrameArgs = {
  ctx: CanvasRenderingContext2D;
  /** The current camera frame, already mirrored + cover-mapped to canvas
   * size, so drawImage(frame, 0, 0) paints exactly what the plain preview
   * would show. */
  frame: CanvasImageSource;
  width: number;
  height: number;
  face: FaceGeometry;
  /** Incremented every background tap; filters use it modulo their backdrop
   * count (the flashcards filter uses it as the card index). */
  backgroundIndex: number;
  /** Cycled by the pipeline's mode button for filters that declare
   * FILTER_MODES (the flashcards' picture style). */
  modeIndex: number;
  maskStretch: MaskStretch;
  /** Filled DURING draw by the cutout helper: where each feature landed on
   * screen this frame — the pipeline hit-tests swipes against it. */
  featureHits: FeatureHit[];
  timeMs: number;
};

export const FILTER_DRAWERS: Record<string, (args: FilterFrameArgs) => void> = {
  potato: (args) => {
    const backdrops = ["potato-dirt", "potato-farm", "potato-rain"];
    drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
    // The potato is buried: fixed in the dirt at a fixed size, but it rolls
    // with your head, and your eyes and lips sit at fixed positions WITHIN
    // the potato (face-masking anchored to the dirt instead of your face).
    const size = Math.min(args.width * 0.62, args.height * 0.42);
    const cx = args.width / 2;
    const cy = args.height * 0.56;
    const tilt = args.face.box.angle;
    drawEmoji(args.ctx, "🥔", cx, cy, size * 1.3, tilt);
    const at = (dx: number, dy: number) => ({
      x: cx + (dx * Math.cos(tilt) - dy * Math.sin(tilt)) * size,
      y: cy + (dx * Math.sin(tilt) + dy * Math.cos(tilt)) * size,
    });
    const leftEye = at(-0.16, -0.14);
    const rightEye = at(0.16, -0.14);
    const lips = at(0, 0.14);
    // face.leftEye is the canvas-left eye (geometry normalizes the mirror
    // swap), so your left-on-screen eye lands on the potato's left.
    drawFeatureCutout(args, "eyes", args.face.leftEye, {
      cx: leftEye.x,
      cy: leftEye.y,
      width: size * 0.28,
      angle: tilt,
    });
    drawFeatureCutout(args, "eyes", args.face.rightEye, {
      cx: rightEye.x,
      cy: rightEye.y,
      width: size * 0.28,
      angle: tilt,
    });
    drawFeatureCutout(args, "lips", args.face.lips, {
      cx: lips.x,
      cy: lips.y,
      width: size * 0.38,
      angle: tilt,
    });
  },
  "eyes-lips": (args) => {
    const backdrops = ["eyes-lips-beach", "eyes-lips-space", "eyes-lips-sunset"];
    drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
    drawFaceCutoutsInPlace(args);
  },
  cat: (args) => {
    const backdrops = ["cat-study", "cat-garden", "cat-livingroom"];
    drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
    // Unlike the potato, the cat is a mask: it follows your face.
    const { box } = args.face;
    drawEmoji(
      args.ctx,
      "🐱",
      box.cx,
      box.cy,
      Math.max(box.width, box.height * 0.8) * 2.4,
      box.angle,
    );
    drawFaceCutoutsInPlace(args);
  },
  flashcards: (args) => {
    const card = FLASHCARDS[args.backgroundIndex % FLASHCARDS.length];
    const style = FLASHCARD_STYLES[args.modeIndex % FLASHCARD_STYLES.length];
    const { ctx, width, height, face } = args;
    ctx.fillStyle = card.background;
    ctx.fillRect(0, 0, width, height);
    // The picture of the thing — no word on the card; the grown-up says it.
    if (card.swatch) {
      ctx.fillStyle = card.swatch;
      ctx.beginPath();
      ctx.arc(width / 2, height * 0.62, width * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = width * 0.015;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    } else {
      const image = cachedImage(
        `flashcard-${style.id}-${card.word}`,
        style.images[card.word] || FLASHCARD_IMAGES_CARTOON[card.word],
      );
      if (image) {
        const cardSize = Math.min(width * 0.72, height * 0.52);
        const x = (width - cardSize) / 2;
        const y = height * 0.63 - cardSize / 2;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, cardSize, cardSize, cardSize * 0.08);
        ctx.clip();
        ctx.drawImage(image, x, y, cardSize, cardSize);
        ctx.restore();
      }
    }
    // The grown-up stays pinned in the top half: eyes and lips remapped to
    // fixed spots up there (patches keep the head's roll, positions don't
    // wander over the card).
    const eyeY = height * 0.15;
    const angle = face.box.angle;
    drawFeatureCutout(args, "eyes", face.leftEye, {
      cx: width / 2 - width * 0.11,
      cy: eyeY,
      width: width * 0.16,
      angle,
    });
    drawFeatureCutout(args, "eyes", face.rightEye, {
      cx: width / 2 + width * 0.11,
      cy: eyeY,
      width: width * 0.16,
      angle,
    });
    drawFeatureCutout(args, "lips", face.lips, {
      cx: width / 2,
      cy: height * 0.25,
      width: width * 0.22,
      angle,
    });
  },
};

// Flashcard picture styles the mode button cycles through. Styles with no
// images yet (photo, until an Unsplash key exists) stay hidden.
const FLASHCARD_STYLES = [
  { id: "cartoon", label: "🖍️ Cartoon", images: FLASHCARD_IMAGES_CARTOON },
  { id: "encyclopaedia", label: "📷 Encyclopaedia", images: FLASHCARD_IMAGES_ENCYCLOPAEDIA },
  { id: "photo", label: "🌍 Real photos", images: FLASHCARD_IMAGES_PHOTO },
].filter((style) => Object.keys(style.images).length > 0);

/** Mode labels per filter id; the pipeline shows a cycle button when a
 * filter has more than one. */
export const FILTER_MODES: Record<string, string[]> = {
  flashcards: FLASHCARD_STYLES.map((style) => style.label),
};

for (const filter of FILTER_PICKER) {
  if (!FILTER_DRAWERS[filter.id]) throw new Error(`Picker filter has no drawer: ${filter.id}`);
}

// Pictures an 18-month-old might know the word for. Tap anywhere to advance.
// Words must exist in the generated image sets (scripts/generate-flashcard-
// images.mjs); color cards draw a swatch instead.
const FLASHCARDS: { word: string; background: string; swatch?: string }[] = [
  { word: "dog", background: "#2874a6" },
  { word: "cat", background: "#af601a" },
  { word: "ball", background: "#239b56" },
  { word: "banana", background: "#6c3483" },
  { word: "apple", background: "#1e8449" },
  { word: "water", background: "#154360" },
  { word: "milk", background: "#7d6608" },
  { word: "baby", background: "#884ea0" },
  { word: "tomato", background: "#1a5276" },
  { word: "cucumber", background: "#943126" },
  { word: "door", background: "#21618c" },
  { word: "chair", background: "#117864" },
  { word: "bed", background: "#6e2c00" },
  { word: "cow", background: "#5b2c6f" },
  { word: "pig", background: "#1d8348" },
  { word: "horse", background: "#1f618d" },
  { word: "sheep", background: "#7b241c" },
  { word: "duck", background: "#9a7d0a" },
  { word: "chicken", background: "#633974" },
  { word: "carrot", background: "#0e6251" },
  { word: "pasta", background: "#78281f" },
  { word: "bread", background: "#4a235a" },
  { word: "cheese", background: "#1b4f72" },
  { word: "egg", background: "#186a3b" },
  { word: "strawberry", background: "#145a32" },
  { word: "grapes", background: "#7e5109" },
  { word: "orange", background: "#283747" },
  { word: "car", background: "#148f77" },
  { word: "bus", background: "#512e5f" },
  { word: "train", background: "#a04000" },
  { word: "book", background: "#0b5345" },
  { word: "star", background: "#1c2833" },
  { word: "moon", background: "#212f3d" },
  { word: "sun", background: "#2471a3" },
  { word: "tree", background: "#6e2c00" },
  { word: "flower", background: "#186a3b" },
  { word: "fish", background: "#7b241c" },
  { word: "bird", background: "#1a5276" },
  { word: "shoe", background: "#117a65" },
  { word: "hat", background: "#b03a2e" },
  { word: "spoon", background: "#2e4053" },
  { word: "red", background: "#34495e", swatch: "#e74c3c" },
  { word: "blue", background: "#34495e", swatch: "#3498db" },
  { word: "green", background: "#34495e", swatch: "#2ecc71" },
  { word: "yellow", background: "#34495e", swatch: "#f1c40f" },
];

// Data-URI images decode lazily; cached across frames. Returns null for the
// first frame or two while the image decodes (callers draw without it).
const imageCache = new Map<string, HTMLImageElement>();

function cachedImage(key: string, dataUri: string | undefined): HTMLImageElement | null {
  if (!dataUri) return null;
  let image = imageCache.get(key);
  if (!image) {
    image = new Image();
    image.src = dataUri;
    imageCache.set(key, image);
  }
  return image.complete && image.naturalWidth ? image : null;
}

function drawBackdrop(args: FilterFrameArgs, id: string) {
  const { ctx, width, height } = args;
  const image = cachedImage(`backdrop-${id}`, FILTER_BACKDROPS[id]);
  if (!image) {
    // One-frame (or failed-decode) fallback so the scene is never blank.
    ctx.fillStyle = "#5d4a36";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  ctx.drawImage(
    image,
    (width - image.naturalWidth * scale) / 2,
    (height - image.naturalHeight * scale) / 2,
    image.naturalWidth * scale,
    image.naturalHeight * scale,
  );
}

function drawEmoji(
  ctx: CanvasRenderingContext2D,
  emoji: string,
  cx: number,
  cy: number,
  sizePx: number,
  angle: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.font = `${Math.round(sizePx)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, 0, 0);
  ctx.restore();
}

/** The mask arrangement: your eyes and lips drawn exactly where they are. */
function drawFaceCutoutsInPlace(args: FilterFrameArgs) {
  drawFeatureCutout(args, "eyes", args.face.leftEye, null);
  drawFeatureCutout(args, "eyes", args.face.rightEye, null);
  drawFeatureCutout(args, "lips", args.face.lips, null);
}

// Baseline mask looseness before the user's adjustable stretch: enough to
// include lashes and the lip line, no more.
const BASE_EXPAND: Record<keyof MaskStretch, number> = { eyes: 1.45, lips: 1.25 };

// Scratch canvases reused across frames: the sampled patch and its
// polygon mask (drawn small, upscaled with smoothing = cheap feather).
let scratch: HTMLCanvasElement | null = null;
let maskScratch: HTMLCanvasElement | null = null;

/** Sample the live video under a tracked feature — the mask's shape is the
 * feature's own landmark ring, inflated by the per-kind base looseness and
 * the user's adjustable stretch — and paint it in place (`dest: null`) or
 * remapped (uniformly scaled to `dest.width`, so nothing squashes) onto a
 * character or screen region. Records where it landed in args.featureHits
 * so the pipeline can hit-test the user's mask-adjust swipes. */
function drawFeatureCutout(
  args: FilterFrameArgs,
  kind: keyof MaskStretch,
  feature: FaceFeature,
  dest: { cx: number; cy: number; width: number; angle: number } | null,
) {
  const { ctx, frame } = args;
  const stretch = args.maskStretch[kind];
  const expandX = BASE_EXPAND[kind] * stretch.x;
  const expandY = BASE_EXPAND[kind] * stretch.y;

  // Inflate the ring around its centroid in face-local (roll-aligned) axes.
  const cos = Math.cos(feature.angle);
  const sin = Math.sin(feature.angle);
  const polygon = feature.ring.map((p) => {
    const dx = p.x - feature.center.x;
    const dy = p.y - feature.center.y;
    const localX = (dx * cos + dy * sin) * expandX;
    const localY = (-dx * sin + dy * cos) * expandY;
    return {
      x: feature.center.x + localX * cos - localY * sin,
      y: feature.center.y + localX * sin + localY * cos,
    };
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // Margin so the feather has room to fade inside the sampled patch.
  const margin = Math.max(6, (maxX - minX) * 0.15);
  const sx = Math.floor(minX - margin);
  const sy = Math.floor(minY - margin);
  const sw = Math.ceil(maxX - minX + margin * 2);
  const sh = Math.ceil(maxY - minY + margin * 2);
  if (sw <= 0 || sh <= 0 || !Number.isFinite(sw + sh)) return;

  scratch = scratch || document.createElement("canvas");
  if (scratch.width < sw) scratch.width = sw;
  if (scratch.height < sh) scratch.height = sh;
  const sctx = scratch.getContext("2d")!;
  sctx.save();
  sctx.clearRect(0, 0, sw, sh);
  sctx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);

  // Feathered mask: fill the polygon into a small canvas, then upscale it
  // with smoothing — the interpolation is the feather (no ctx.filter, which
  // older WKWebViews lack).
  const maskScale = 6;
  const mw = Math.max(2, Math.round(sw / maskScale));
  const mh = Math.max(2, Math.round(sh / maskScale));
  maskScratch = maskScratch || document.createElement("canvas");
  if (maskScratch.width < mw) maskScratch.width = mw;
  if (maskScratch.height < mh) maskScratch.height = mh;
  const mctx = maskScratch.getContext("2d")!;
  // Clear the WHOLE reused canvas: upscaling samples bilinearly at the
  // region's edges, and stale fill just outside the region bleeds in as a
  // faint rectangle around the cutout (harness-caught).
  mctx.clearRect(0, 0, maskScratch.width, maskScratch.height);
  mctx.beginPath();
  polygon.forEach((p, i) => {
    const x = ((p.x - sx) / sw) * mw;
    const y = ((p.y - sy) / sh) * mh;
    if (i === 0) mctx.moveTo(x, y);
    else mctx.lineTo(x, y);
  });
  mctx.closePath();
  mctx.fillStyle = "#000";
  mctx.fill();
  sctx.globalCompositeOperation = "destination-in";
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(maskScratch, 0, 0, mw, mh, 0, 0, sw, sh);
  sctx.restore();

  if (dest === null) {
    ctx.drawImage(scratch, 0, 0, sw, sh, sx, sy, sw, sh);
    args.featureHits.push({
      kind,
      cx: sx + sw / 2,
      cy: sy + sh / 2,
      radius: Math.max(sw, sh) / 2,
    });
    return;
  }
  // Uniform scale: the patch keeps YOUR feature's aspect ratio.
  const scale = dest.width / sw;
  ctx.save();
  ctx.translate(dest.cx, dest.cy);
  // The sampled patch is already in canvas orientation (it carries the
  // face's roll), so only the source→dest orientation difference applies.
  ctx.rotate(dest.angle - feature.angle);
  ctx.drawImage(
    scratch,
    0,
    0,
    sw,
    sh,
    (-sw * scale) / 2,
    (-sh * scale) / 2,
    sw * scale,
    sh * scale,
  );
  ctx.restore();
  args.featureHits.push({
    kind,
    cx: dest.cx,
    cy: dest.cy,
    radius: (Math.max(sw, sh) * scale) / 2,
  });
}
