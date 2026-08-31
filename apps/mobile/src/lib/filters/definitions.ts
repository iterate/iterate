// The 2020-era Zoom filters. Each filter is a plain draw function over
// (canvas ctx, current video frame, face geometry, tap-cycled background
// index) — deliberately data-shaped so a later PR can load agent-written
// filters from userland streams through this same interface.
//
// Art direction: emoji + canvas vector drawing only, so there are no image
// assets to bundle. The "real eyes and lips" effect samples the live video
// through feathered elliptical cutouts at the tracked landmark positions.

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
  /** Incremented every background tap; filters use it modulo their scene
   * count (the flashcards filter uses it as the card index). */
  backgroundIndex: number;
  timeMs: number;
};

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
      const scenes: Scene[] = [
        {
          sky: ["#7ec8e3", "#cfe9f5"],
          ground: { color: "#6b4a2b", heightFraction: 0.42 },
          props: [
            { emoji: "☀️", x: 0.85, y: 0.1, size: 0.14 },
            { emoji: "🌱", x: 0.12, y: 0.62, size: 0.1 },
            { emoji: "🌱", x: 0.82, y: 0.72, size: 0.12 },
            { emoji: "🪱", x: 0.2, y: 0.88, size: 0.1 },
          ],
        },
        {
          sky: ["#f8c471", "#fdebd0"],
          ground: { color: "#8a6d3b", heightFraction: 0.38 },
          props: [
            { emoji: "🌾", x: 0.1, y: 0.66, size: 0.13 },
            { emoji: "🐄", x: 0.85, y: 0.68, size: 0.14 },
            { emoji: "🚜", x: 0.18, y: 0.8, size: 0.15 },
          ],
        },
        {
          sky: ["#5d6d7e", "#85929e"],
          ground: { color: "#4d3319", heightFraction: 0.45 },
          props: [
            { emoji: "🌧️", x: 0.2, y: 0.12, size: 0.14 },
            { emoji: "🌧️", x: 0.7, y: 0.08, size: 0.12 },
            { emoji: "🍄", x: 0.85, y: 0.75, size: 0.12 },
          ],
        },
      ];
      drawScene(args, scenes[args.backgroundIndex % scenes.length]);
      drawEmojiOverFace(args, "🥔", 2.3);
      drawRealEyesAndLips(args);
    },
  },
  {
    id: "eyes-lips",
    label: "Eyes & lips",
    emoji: "👄",
    draw: (args) => {
      const scenes: Scene[] = [
        {
          sky: ["#1a5276", "#2e86c1"],
          ground: { color: "#f7dc6f", heightFraction: 0.3 },
          props: [
            { emoji: "🌊", x: 0.2, y: 0.62, size: 0.14 },
            { emoji: "🏝️", x: 0.82, y: 0.58, size: 0.16 },
            { emoji: "☀️", x: 0.12, y: 0.1, size: 0.13 },
          ],
        },
        {
          sky: ["#0b0b2b", "#1b1b4b"],
          props: [
            { emoji: "🪐", x: 0.8, y: 0.15, size: 0.16 },
            { emoji: "⭐", x: 0.15, y: 0.2, size: 0.09 },
            { emoji: "⭐", x: 0.6, y: 0.75, size: 0.07 },
            { emoji: "🌙", x: 0.25, y: 0.85, size: 0.13 },
          ],
        },
        {
          sky: ["#78281f", "#e74c3c"],
          ground: { color: "#17202a", heightFraction: 0.25 },
          props: [
            { emoji: "🌇", x: 0.5, y: 0.55, size: 0.2 },
            { emoji: "🦇", x: 0.2, y: 0.18, size: 0.1 },
          ],
        },
      ];
      drawScene(args, scenes[args.backgroundIndex % scenes.length]);
      drawRealEyesAndLips(args);
    },
  },
  {
    id: "cat",
    label: "Cat",
    emoji: "🐱",
    draw: (args) => {
      const scenes: Scene[] = [
        {
          // The lawyer's study, for authenticity.
          sky: ["#4a3728", "#7a5c43"],
          ground: { color: "#2e2018", heightFraction: 0.3 },
          props: [
            { emoji: "📚", x: 0.14, y: 0.28, size: 0.16 },
            { emoji: "📚", x: 0.86, y: 0.32, size: 0.14 },
            { emoji: "💼", x: 0.82, y: 0.78, size: 0.14 },
          ],
        },
        {
          sky: ["#a9dfbf", "#d4efdf"],
          ground: { color: "#58d68d", heightFraction: 0.35 },
          props: [
            { emoji: "🌸", x: 0.15, y: 0.7, size: 0.11 },
            { emoji: "🦋", x: 0.8, y: 0.2, size: 0.11 },
            { emoji: "🪴", x: 0.85, y: 0.72, size: 0.14 },
          ],
        },
        {
          sky: ["#d6dbdf", "#fbfcfc"],
          ground: { color: "#aab7b8", heightFraction: 0.28 },
          props: [
            { emoji: "🛋️", x: 0.5, y: 0.68, size: 0.24 },
            { emoji: "🧶", x: 0.15, y: 0.85, size: 0.12 },
          ],
        },
      ];
      drawScene(args, scenes[args.backgroundIndex % scenes.length]);
      drawEmojiOverFace(args, "🐱", 2.4);
      drawRealEyesAndLips(args);
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
      if (card.swatch) {
        ctx.fillStyle = card.swatch;
        ctx.beginPath();
        ctx.arc(width / 2, height * 0.68, width * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = width * 0.015;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      } else {
        drawEmoji(args.ctx, card.emoji!, width / 2, height * 0.68, width * 0.55, 0);
      }
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.round(height * 0.07)}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(card.word, width / 2, height * 0.92);
      // The grown-up floats above the card, eyes and lips only, shrunk out
      // of the way so the card stays the star.
      drawRealEyesAndLips(args);
    },
  },
];

// Words an 18-month-old might know. Tap anywhere to advance.
const FLASHCARDS: { word: string; emoji?: string; background: string; swatch?: string }[] = [
  { word: "dog", emoji: "🐶", background: "#2874a6" },
  { word: "cat", emoji: "🐱", background: "#af601a" },
  { word: "ball", emoji: "⚽", background: "#239b56" },
  { word: "banana", emoji: "🍌", background: "#6c3483" },
  { word: "apple", emoji: "🍎", background: "#1e8449" },
  { word: "water", emoji: "💧", background: "#154360" },
  { word: "milk", emoji: "🥛", background: "#7d6608" },
  { word: "baby", emoji: "👶", background: "#884ea0" },
  { word: "tomato", emoji: "🍅", background: "#1a5276" },
  { word: "cucumber", emoji: "🥒", background: "#943126" },
  { word: "door", emoji: "🚪", background: "#21618c" },
  { word: "chair", emoji: "🪑", background: "#117864" },
  { word: "bed", emoji: "🛏️", background: "#6e2c00" },
  { word: "cow", emoji: "🐮", background: "#5b2c6f" },
  { word: "pig", emoji: "🐷", background: "#1d8348" },
  { word: "horse", emoji: "🐴", background: "#1f618d" },
  { word: "sheep", emoji: "🐑", background: "#7b241c" },
  { word: "duck", emoji: "🦆", background: "#9a7d0a" },
  { word: "chicken", emoji: "🐔", background: "#633974" },
  { word: "carrot", emoji: "🥕", background: "#0e6251" },
  { word: "pasta", emoji: "🍝", background: "#78281f" },
  { word: "bread", emoji: "🍞", background: "#4a235a" },
  { word: "cheese", emoji: "🧀", background: "#1b4f72" },
  { word: "egg", emoji: "🥚", background: "#186a3b" },
  { word: "strawberry", emoji: "🍓", background: "#145a32" },
  { word: "grapes", emoji: "🍇", background: "#7e5109" },
  { word: "orange", emoji: "🍊", background: "#283747" },
  { word: "car", emoji: "🚗", background: "#148f77" },
  { word: "bus", emoji: "🚌", background: "#512e5f" },
  { word: "train", emoji: "🚂", background: "#a04000" },
  { word: "book", emoji: "📖", background: "#0b5345" },
  { word: "star", emoji: "⭐", background: "#1c2833" },
  { word: "moon", emoji: "🌙", background: "#212f3d" },
  { word: "sun", emoji: "☀️", background: "#2471a3" },
  { word: "tree", emoji: "🌳", background: "#6e2c00" },
  { word: "flower", emoji: "🌸", background: "#186a3b" },
  { word: "fish", emoji: "🐟", background: "#7b241c" },
  { word: "bird", emoji: "🐦", background: "#1a5276" },
  { word: "shoe", emoji: "👟", background: "#117a65" },
  { word: "hat", emoji: "🎩", background: "#b03a2e" },
  { word: "spoon", emoji: "🥄", background: "#2e4053" },
  { word: "red", background: "#34495e", swatch: "#e74c3c" },
  { word: "blue", background: "#34495e", swatch: "#3498db" },
  { word: "green", background: "#34495e", swatch: "#2ecc71" },
  { word: "yellow", background: "#34495e", swatch: "#f1c40f" },
];

type Scene = {
  /** Vertical gradient top→bottom. */
  sky: [string, string];
  ground?: { color: string; heightFraction: number };
  props: { emoji: string; x: number; y: number; size: number }[];
};

function drawScene(args: FilterFrameArgs, scene: Scene) {
  const { ctx, width, height } = args;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, scene.sky[0]);
  gradient.addColorStop(1, scene.sky[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  if (scene.ground) {
    ctx.fillStyle = scene.ground.color;
    const top = height * (1 - scene.ground.heightFraction);
    ctx.beginPath();
    // A soft hill instead of a hard horizon line.
    ctx.moveTo(0, top + height * 0.03);
    ctx.quadraticCurveTo(width / 2, top - height * 0.03, width, top + height * 0.03);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();
  }
  for (const prop of scene.props) {
    drawEmoji(ctx, prop.emoji, prop.x * width, prop.y * height, prop.size * width, 0);
  }
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

/** The face-replacement move: a giant emoji sized to the tracked face box,
 * rolling with the head. */
function drawEmojiOverFace(args: FilterFrameArgs, emoji: string, scale: number) {
  const { box } = args.face;
  drawEmoji(
    args.ctx,
    emoji,
    box.cx,
    box.cy,
    Math.max(box.width, box.height * 0.8) * scale,
    box.angle,
  );
}

/** Sample the live video through feathered elliptical cutouts at the eye and
 * lip positions — the "it's just their eyes and lips floating there" effect
 * every 2020 filter mishap was built on. */
function drawRealEyesAndLips(args: FilterFrameArgs) {
  drawFeatheredCutout(args, args.face.leftEye);
  drawFeatheredCutout(args, args.face.rightEye);
  drawFeatheredCutout(args, args.face.lips);
}

// Scratch canvas reused across frames for the feathered cutouts.
let scratch: HTMLCanvasElement | null = null;

function drawFeatheredCutout(args: FilterFrameArgs, ellipse: Ellipse) {
  const { ctx, frame } = args;
  const pad = 1.25;
  const w = Math.ceil(ellipse.rx * 2 * pad);
  const h = Math.ceil(ellipse.ry * 2 * pad);
  if (w <= 0 || h <= 0) return;
  scratch = scratch || document.createElement("canvas");
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const sctx = scratch.getContext("2d")!;
  sctx.save();
  sctx.clearRect(0, 0, w, h);
  // Pull the (already canvas-mapped) frame region under the ellipse. The
  // ellipse may be rotated; sampling the axis-aligned bounding region keeps
  // this cheap and the feather hides the difference.
  const sx = ellipse.cx - w / 2;
  const sy = ellipse.cy - h / 2;
  sctx.drawImage(frame, sx, sy, w, h, 0, 0, w, h);
  // Feather: keep pixels inside an elliptical radial falloff, erase the
  // rest. destination-in zeroes everything the mask fill leaves unpainted.
  sctx.globalCompositeOperation = "destination-in";
  sctx.translate(w / 2, h / 2);
  sctx.scale(w / 2, h / 2);
  const mask = sctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.72, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  sctx.fillStyle = mask;
  sctx.fillRect(-1, -1, 2, 2);
  sctx.restore();
  ctx.drawImage(scratch, 0, 0, w, h, sx, sy, w, h);
}
