// The 2020-era Zoom filters. Each filter is a plain draw function over
// (canvas ctx, current video frame, face geometry, tap-cycled background
// index) — deliberately data-shaped so a later PR can load agent-written
// filters from userland streams through this same interface.
//
// Backdrops are AI-generated images (scripts/generate-filter-backdrops.mjs,
// committed as data URIs in backdrops.generated.ts); face art is emoji. The
// "real eyes and lips" effect samples the live video through feathered
// elliptical cutouts at the tracked landmark positions — either drawn in
// place (a mask following your face) or remapped onto a drawn character
// (your face on the buried potato).

import { FILTER_BACKDROPS } from "./backdrops.generated.ts";
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

/** Filtered recordings are re-encoded on-canvas and cross the WebView bridge
 * as one base64 message, so they stay shorter than plain camera clips.
 * Lives here (not filter-camera.tsx) because "use dom" modules only allow a
 * single default export at runtime. */
export const FILTERED_CLIP_MAX_SECONDS = 30;

export type FilterDefinition = {
  id: string;
  label: string;
  /** Shown on the picker chip. */
  emoji: string;
  draw: (args: FilterFrameArgs) => void;
};

export const CAMERA_FILTERS: FilterDefinition[] = [
  {
    id: "potato",
    label: "Potato",
    emoji: "🥔",
    draw: (args) => {
      const backdrops = ["potato-dirt", "potato-farm", "potato-rain"];
      drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
      // The potato is buried: fixed in the dirt at a fixed size, but it
      // rolls with your head, and your eyes and lips sit at fixed positions
      // WITHIN the potato (standard face-masking, just anchored to the dirt
      // instead of your face).
      const size = Math.min(args.width * 0.62, args.height * 0.42);
      const cx = args.width / 2;
      const cy = args.height * 0.56;
      const tilt = -0.14 + args.face.box.angle;
      drawEmoji(args.ctx, "🥔", cx, cy, size * 1.3, tilt);
      const at = (dx: number, dy: number) => ({
        x: cx + (dx * Math.cos(tilt) - dy * Math.sin(tilt)) * size,
        y: cy + (dx * Math.sin(tilt) + dy * Math.cos(tilt)) * size,
      });
      const leftEye = at(-0.16, -0.14);
      const rightEye = at(0.16, -0.14);
      const lips = at(0, 0.14);
      drawFeatheredCutout(args, args.face.leftEye, {
        cx: leftEye.x,
        cy: leftEye.y,
        rx: size * 0.14,
        ry: size * 0.1,
        angle: tilt,
      });
      drawFeatheredCutout(args, args.face.rightEye, {
        cx: rightEye.x,
        cy: rightEye.y,
        rx: size * 0.14,
        ry: size * 0.1,
        angle: tilt,
      });
      drawFeatheredCutout(args, args.face.lips, {
        cx: lips.x,
        cy: lips.y,
        rx: size * 0.19,
        ry: size * 0.12,
        angle: tilt,
      });
    },
  },
  {
    id: "eyes-lips",
    label: "Eyes & lips",
    emoji: "👄",
    draw: (args) => {
      const backdrops = ["eyes-lips-beach", "eyes-lips-space", "eyes-lips-sunset"];
      drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
      drawFaceCutoutsInPlace(args);
    },
  },
  {
    id: "cat",
    label: "Cat",
    emoji: "🐱",
    draw: (args) => {
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
  },
  {
    id: "flashcards",
    label: "Flashcards",
    emoji: "🍎",
    draw: (args) => {
      const card = FLASHCARDS[args.backgroundIndex % FLASHCARDS.length];
      const { ctx, width, height } = args;
      ctx.fillStyle = card.background;
      ctx.fillRect(0, 0, width, height);
      // No word on the card — the grown-up says it; the card just shows the
      // picture of the thing.
      if (card.swatch) {
        ctx.fillStyle = card.swatch;
        ctx.beginPath();
        ctx.arc(width / 2, height * 0.62, width * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = width * 0.015;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      } else {
        drawEmoji(args.ctx, card.emoji!, width / 2, height * 0.62, width * 0.62, 0);
      }
      // The grown-up floats above the card, eyes and lips only, out of the
      // way so the card stays the star.
      drawFaceCutoutsInPlace(args);
    },
  },
];

// Pictures an 18-month-old might know the word for. Tap anywhere to advance.
const FLASHCARDS: { emoji?: string; background: string; swatch?: string }[] = [
  { emoji: "🐶", background: "#2874a6" },
  { emoji: "🐱", background: "#af601a" },
  { emoji: "⚽", background: "#239b56" },
  { emoji: "🍌", background: "#6c3483" },
  { emoji: "🍎", background: "#1e8449" },
  { emoji: "💧", background: "#154360" },
  { emoji: "🥛", background: "#7d6608" },
  { emoji: "👶", background: "#884ea0" },
  { emoji: "🍅", background: "#1a5276" },
  { emoji: "🥒", background: "#943126" },
  { emoji: "🚪", background: "#21618c" },
  { emoji: "🪑", background: "#117864" },
  { emoji: "🛏️", background: "#6e2c00" },
  { emoji: "🐮", background: "#5b2c6f" },
  { emoji: "🐷", background: "#1d8348" },
  { emoji: "🐴", background: "#1f618d" },
  { emoji: "🐑", background: "#7b241c" },
  { emoji: "🦆", background: "#9a7d0a" },
  { emoji: "🐔", background: "#633974" },
  { emoji: "🥕", background: "#0e6251" },
  { emoji: "🍝", background: "#78281f" },
  { emoji: "🍞", background: "#4a235a" },
  { emoji: "🧀", background: "#1b4f72" },
  { emoji: "🥚", background: "#186a3b" },
  { emoji: "🍓", background: "#145a32" },
  { emoji: "🍇", background: "#7e5109" },
  { emoji: "🍊", background: "#283747" },
  { emoji: "🚗", background: "#148f77" },
  { emoji: "🚌", background: "#512e5f" },
  { emoji: "🚂", background: "#a04000" },
  { emoji: "📖", background: "#0b5345" },
  { emoji: "⭐", background: "#1c2833" },
  { emoji: "🌙", background: "#212f3d" },
  { emoji: "☀️", background: "#2471a3" },
  { emoji: "🌳", background: "#6e2c00" },
  { emoji: "🌸", background: "#186a3b" },
  { emoji: "🐟", background: "#7b241c" },
  { emoji: "🐦", background: "#1a5276" },
  { emoji: "👟", background: "#117a65" },
  { emoji: "🎩", background: "#b03a2e" },
  { emoji: "🥄", background: "#2e4053" },
  { background: "#34495e", swatch: "#e74c3c" },
  { background: "#34495e", swatch: "#3498db" },
  { background: "#34495e", swatch: "#2ecc71" },
  { background: "#34495e", swatch: "#f1c40f" },
];

// Backdrop images decode lazily from their data URIs; cached across frames.
const backdropCache = new Map<string, HTMLImageElement>();

function drawBackdrop(args: FilterFrameArgs, id: string) {
  const { ctx, width, height } = args;
  let image = backdropCache.get(id);
  if (!image) {
    image = new Image();
    image.src = FILTER_BACKDROPS[id];
    backdropCache.set(id, image);
  }
  if (!image.complete || !image.naturalWidth) {
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
