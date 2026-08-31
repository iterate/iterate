// The 2020-era Zoom filters. Each filter is a plain draw function over
// (canvas ctx, current video frame, face geometry, tap-cycled background
// index) — deliberately data-shaped so a later PR can load agent-written
// filters from userland streams through this same interface.
//
// ONLY import this module from the filter-camera DOM component (and its
// test harness): the generated image imports below are megabytes that must
// not ride into the native Hermes bundle. The native picker reads picker.ts.
//
// Backdrops and flashcard pictures are AI-generated images (the
// scripts/generate-*.mjs scripts, committed as data URIs); face art is
// emoji. The "real eyes and lips" effect samples the live video through
// feathered elliptical cutouts at the tracked landmark positions — drawn in
// place (a mask following your face), or remapped onto a character (the
// buried potato), or pinned to a screen region (the flashcards keep your
// face in the top half).

import { FILTER_BACKDROPS } from "./backdrops.generated.ts";
import { FLASHCARD_IMAGES } from "./flashcards.generated.ts";
import { FILTER_PICKER } from "./picker.ts";
import type { Ellipse, FaceGeometry } from "./face-geometry.ts";

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
    drawFeatheredCutout(args, args.face.leftEye, {
      cx: leftEye.x,
      cy: leftEye.y,
      rx: size * 0.12,
      ry: size * 0.08,
      angle: tilt,
    });
    drawFeatheredCutout(args, args.face.rightEye, {
      cx: rightEye.x,
      cy: rightEye.y,
      rx: size * 0.12,
      ry: size * 0.08,
      angle: tilt,
    });
    drawFeatheredCutout(args, args.face.lips, {
      cx: lips.x,
      cy: lips.y,
      rx: size * 0.17,
      ry: size * 0.1,
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
      const image = cachedImage(`flashcard-${card.word}`, FLASHCARD_IMAGES[card.word]);
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
    // The grown-up stays pinned in the top half: eyes and lips remapped to a
    // fixed spot up there (patches keep the head's roll — dest.angle follows
    // it — but the positions don't wander over the card).
    const eyeY = height * 0.15;
    const angle = face.box.angle;
    drawFeatheredCutout(args, face.leftEye, {
      cx: width / 2 - width * 0.11,
      cy: eyeY,
      rx: width * 0.08,
      ry: width * 0.055,
      angle,
    });
    drawFeatheredCutout(args, face.rightEye, {
      cx: width / 2 + width * 0.11,
      cy: eyeY,
      rx: width * 0.08,
      ry: width * 0.055,
      angle,
    });
    drawFeatheredCutout(args, face.lips, {
      cx: width / 2,
      cy: height * 0.25,
      rx: width * 0.11,
      ry: width * 0.065,
      angle,
    });
  },
};

for (const filter of FILTER_PICKER) {
  if (!FILTER_DRAWERS[filter.id]) throw new Error(`Picker filter has no drawer: ${filter.id}`);
}

// Pictures an 18-month-old might know the word for. Tap anywhere to advance.
// Words must exist in FLASHCARD_IMAGES (scripts/generate-flashcard-images
// .mjs); color cards draw a swatch instead.
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
  drawFeatheredCutout(args, args.face.leftEye, args.face.leftEye);
  drawFeatheredCutout(args, args.face.rightEye, args.face.rightEye);
  drawFeatheredCutout(args, args.face.lips, args.face.lips);
}

// Scratch canvas reused across frames for the feathered cutouts.
let scratch: HTMLCanvasElement | null = null;

/** Sample the live video under `source` (a tracked feature), feather its
 * edge, and paint it into `dest` — same place for masks, somewhere else
 * entirely for character remapping (eyes on a potato). */
function drawFeatheredCutout(args: FilterFrameArgs, source: Ellipse, dest: Ellipse) {
  const { ctx, frame } = args;
  const pad = 1.25;
  const sw = Math.ceil(source.rx * 2 * pad);
  const sh = Math.ceil(source.ry * 2 * pad);
  if (sw <= 0 || sh <= 0) return;
  scratch = scratch || document.createElement("canvas");
  if (scratch.width < sw) scratch.width = sw;
  if (scratch.height < sh) scratch.height = sh;
  const sctx = scratch.getContext("2d")!;
  sctx.save();
  sctx.clearRect(0, 0, sw, sh);
  // Pull the (already canvas-mapped) frame region under the source ellipse.
  // The ellipse may be rotated; sampling the axis-aligned bounding region
  // keeps this cheap and the feather hides the difference.
  sctx.drawImage(frame, source.cx - sw / 2, source.cy - sh / 2, sw, sh, 0, 0, sw, sh);
  // Feather: keep pixels inside an elliptical radial falloff, erase the
  // rest. destination-in zeroes everything the mask fill leaves unpainted.
  sctx.globalCompositeOperation = "destination-in";
  sctx.translate(sw / 2, sh / 2);
  sctx.scale(sw / 2, sh / 2);
  const mask = sctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.72, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  sctx.fillStyle = mask;
  sctx.fillRect(-1, -1, 2, 2);
  sctx.restore();
  const dw = dest.rx * 2 * pad;
  const dh = dest.ry * 2 * pad;
  ctx.save();
  ctx.translate(dest.cx, dest.cy);
  // The sampled patch is already in canvas orientation (it carries the
  // face's roll), so only the source→dest orientation difference is applied
  // — zero for in-place masks.
  ctx.rotate(dest.angle - source.angle);
  ctx.drawImage(scratch, 0, 0, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
