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
import { foldedSemitoneOffset, SOLFEGE } from "./pitch.ts";
import { ellipseFeature, type FaceFeature, type FaceGeometry } from "./face-geometry.ts";

/** How loose the cutout masks are around the tracked features, per feature
 * kind — 1 is the default; the pipeline lets the user drag these. */
export type MaskStretch = { eyes: { x: number; y: number }; lips: { x: number; y: number } };

export type FeatureHit = { kind: keyof MaskStretch; cx: number; cy: number; radius: number };

/** The toolkit handed to every filter through args.helpers — the whole
 * surface a dynamically-loaded (agent-written) filter can rely on, already
 * bound to the current frame. Built-in filters use the same primitives via
 * module functions; this is their stable, importless form. */
export type FilterHelpers = {
  /** Sample the live video under a tracked feature and paint it — in place
   * (no dest) or remapped to dest (uniform scale, so nothing squashes). */
  featureCutout: (
    kind: keyof MaskStretch,
    feature: FaceFeature,
    dest?: { cx: number; cy: number; width: number; angle: number } | null,
  ) => void;
  /** The dest.width that renders a feature at natural 1:1 size. */
  naturalWidth: (kind: keyof MaskStretch, feature: FaceFeature) => number;
  /** An elliptical stand-in feature — sample skin patches, invent features. */
  ellipseFeature: typeof ellipseFeature;
  emoji: (glyph: string, cx: number, cy: number, sizePx: number, angle: number) => void;
  /** Decode-once image cache for data URIs (null while decoding). */
  cachedImage: (key: string, dataUri: string | undefined) => HTMLImageElement | null;
  /** Cover-fit an image over the whole canvas. */
  imageCover: (image: HTMLImageElement) => void;
};

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
  /** Head movement relative to the baseline captured when the filter
   * started: canvas-pixel offsets and a z-ish scale (face width ratio, >1 =
   * closer). {0,0,1} while untracked. */
  facePose: { dx: number; dy: number; scale: number };
  maskStretch: MaskStretch;
  /** Filled DURING draw by the cutout helper: where each feature landed on
   * screen this frame — the pipeline hit-tests swipes against it. */
  featureHits: FeatureHit[];
  /** Fundamental of whatever the mic hears right now (autocorrelation over
   * the live audio track), or null in silence — the sing filter's input. */
  pitchHz: number | null;
  helpers: FilterHelpers;
  timeMs: number;
};

/** Assemble frame args with the helpers kit bound to them (the pipeline
 * calls this once per frame). */
export function buildFrameArgs(base: Omit<FilterFrameArgs, "helpers">): FilterFrameArgs {
  // The cast exists only because helpers closes over the finished args
  // object; it is assigned on the next statement.
  const args = base as FilterFrameArgs;
  args.helpers = {
    featureCutout: (kind, feature, dest = null) => drawFeatureCutout(args, kind, feature, dest),
    naturalWidth: naturalCutoutWidth,
    ellipseFeature,
    emoji: (glyph, cx, cy, sizePx, angle) => drawEmoji(args.ctx, glyph, cx, cy, sizePx, angle),
    cachedImage,
    imageCover: (image) => drawImageCover(args.ctx, image, args.width, args.height),
  };
  return args;
}

/** A project-authored filter: the `filters/<name>.filter.js` repo file must
 * be a single JS object expression of this shape. See evaluateDynamicFilter. */
export type DynamicFilterDefinition = {
  label: string;
  emoji: string;
  /** Optional mode labels — the pipeline shows its cycle button for them. */
  modes?: string[];
  draw: (args: FilterFrameArgs) => void;
};

/** Evaluate a project filter's source. The contract keeps vibe-coding easy:
 * the file is one object expression, e.g.
 *
 *   ({
 *     label: "Carrot",
 *     emoji: "🥕",
 *     draw(args) {
 *       args.ctx.fillStyle = "#7cb342";
 *       args.ctx.fillRect(0, 0, args.width, args.height);
 *       args.helpers.emoji("🥕", args.face.box.cx, args.face.box.cy,
 *         args.face.box.width * 2, args.face.box.angle);
 *       args.helpers.featureCutout("eyes", args.face.leftEye);
 *       args.helpers.featureCutout("eyes", args.face.rightEye);
 *       args.helpers.featureCutout("lips", args.face.lips);
 *     },
 *   })
 *
 * Runs in the WebView with the same trust as the rest of the project's
 * userland code. Throws (with a useful message) on a malformed file. */
export function evaluateDynamicFilter(source: string): DynamicFilterDefinition {
  // eslint-disable-next-line no-new-func -- evaluating project-authored filter code is the feature
  const definition = new Function(`"use strict"; return (
${source}
);`)() as DynamicFilterDefinition | undefined;
  if (!definition || typeof definition.draw !== "function") {
    throw new Error("A filter file must be one object expression with a draw(args) function");
  }
  return definition;
}

export const FILTER_DRAWERS: Record<string, (args: FilterFrameArgs) => void> = {
  potato: (args) => {
    const backdrops = ["potato-dirt", "potato-farm", "potato-rain"];
    drawBackdrop(args, backdrops[args.backgroundIndex % backdrops.length]);
    // The potato starts buried mid-dirt and then FOLLOWS your head: move
    // up/down/left/right and it moves, come closer and it grows, roll and
    // it rolls — all relative to where your face was when the filter
    // started. Your eyes and lips sit at fixed positions WITHIN the potato.
    const pose = args.facePose;
    const zoom = Math.min(2.2, Math.max(0.45, pose.scale));
    const size = Math.min(args.width * 0.62, args.height * 0.42) * zoom;
    const cx = args.width / 2 + pose.dx;
    const cy = args.height * 0.56 + pose.dy;
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
    // fixed spots up there (patches keep the head's roll and grow as you
    // lean in, but positions don't wander over the card).
    const eyeY = height * 0.15;
    const angle = face.box.angle;
    const zoom = Math.min(1.8, Math.max(0.6, args.facePose.scale));
    drawFeatureCutout(args, "eyes", face.leftEye, {
      cx: width / 2 - width * 0.11,
      cy: eyeY,
      width: width * 0.16 * zoom,
      angle,
    });
    drawFeatureCutout(args, "eyes", face.rightEye, {
      cx: width / 2 + width * 0.11,
      cy: eyeY,
      width: width * 0.16 * zoom,
      angle,
    });
    drawFeatureCutout(args, "lips", face.lips, {
      cx: width / 2,
      cy: height * 0.25,
      width: width * 0.22 * zoom,
      angle,
    });
  },
  sing: (args) => {
    const { ctx, width, height, face, timeMs } = args;
    const game = singState;
    if (game.lastTap !== args.backgroundIndex) {
      game.lastTap = args.backgroundIndex;
      game.note = 0;
      game.wallStartMs = timeMs;
      game.ballPos = -2;
      game.winUntil = 0;
      game.flashUntil = 0;
    }
    ctx.drawImage(args.frame, 0, 0);
    ctx.fillStyle = "rgba(10, 10, 25, 0.45)";
    ctx.fillRect(0, 0, width, height);

    // Vertical scale: do at the bottom, high do at the top.
    const yFor = (semitone: number) => height * 0.82 - (semitone / 12) * (height * 0.6);
    const target = SOLFEGE[game.note];
    const targetY = yFor(target.semitone);
    // ±half a semitone (a quarter tone each way) counts as on-pitch.
    const toleranceSemitones = 0.5;
    const gapHalf = (toleranceSemitones / 12) * height * 0.6 + height * 0.012;

    // The ball rides your sung pitch, octave-folded around the TARGET note
    // — sing in whichever octave you like.
    const hz = args.pitchHz;
    const goalPos =
      hz === null
        ? -2
        : target.semitone + foldedSemitoneOffset(hz, DO_HZ * 2 ** (target.semitone / 12));
    game.ballPos += (goalPos - game.ballPos) * 0.25;
    const ballX = width * 0.3;
    const ballY = yFor(game.ballPos);

    // Ladder of note names with the current target highlighted.
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const [index, note] of SOLFEGE.entries()) {
      const active = index === game.note;
      ctx.font = `${active ? 700 : 400} ${Math.round(height * (active ? 0.032 : 0.022))}px -apple-system, sans-serif`;
      ctx.fillStyle = active ? "#ffe066" : "rgba(255,255,255,0.55)";
      ctx.fillText(note.name, width * 0.04, yFor(note.semitone));
    }

    // The wall slides in from the right; its hole sits at the target pitch.
    const WALL_MS = 5000;
    const wallWidth = width * 0.06;
    const progress = Math.min(1, (timeMs - game.wallStartMs) / WALL_MS);
    const wallX = width + wallWidth - progress * (width + wallWidth - ballX);
    if (game.winUntil > timeMs) {
      drawEmoji(ctx, "🎉", width / 2, height * 0.4, width * 0.5, 0);
    } else {
      ctx.fillStyle = game.flashUntil > timeMs ? "#e74c3caa" : "#58d68daa";
      ctx.fillRect(wallX, 0, wallWidth, targetY - gapHalf);
      ctx.fillRect(wallX, targetY + gapHalf, wallWidth, height - targetY - gapHalf);
      if (progress >= 1) {
        if (Math.abs(ballY - targetY) <= gapHalf) {
          game.note += 1;
          if (game.note >= SOLFEGE.length) {
            game.note = 0;
            game.winUntil = timeMs + 2500;
          }
        } else {
          game.flashUntil = timeMs + 350;
        }
        game.wallStartMs = timeMs;
      }
    }

    // The ball is your actual mouth.
    ctx.beginPath();
    ctx.arc(ballX, ballY, width * 0.085, 0, Math.PI * 2);
    ctx.fillStyle = hz === null ? "rgba(255,255,255,0.25)" : "rgba(255,224,102,0.35)";
    ctx.fill();
    drawFeatureCutout(args, "lips", face.lips, {
      cx: ballX,
      cy: ballY,
      width: width * 0.14,
      angle: 0,
    });

    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(height * 0.035)}px -apple-system, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`sing ${target.name}`, width / 2, height * 0.06);
    ctx.font = `400 ${Math.round(height * 0.018)}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(
      hz === null ? "any octave works — make some noise" : `${Math.round(hz)}Hz`,
      width / 2,
      height * 0.09,
    );
  },
  "face-drop": (args) => {
    const { ctx, width, height, face, timeMs } = args;
    const game = faceDropState;
    if (game.lastTap !== args.backgroundIndex) {
      game.lastTap = args.backgroundIndex;
      game.stage = 0;
      game.locked = [];
      game.cycleStartMs = timeMs;
      game.eyesClosed = false;
    }
    ctx.drawImage(args.frame, 0, 0);

    const box = face.box;
    const features: { kind: keyof MaskStretch; feature: FaceFeature }[] = [
      { kind: "eyes", feature: face.leftEye },
      { kind: "eyes", feature: face.rightEye },
      { kind: "lips", feature: face.lips },
    ];

    // Blank the face: cover every feature's home spot with nearby skin
    // (cheek below the eyes, beside the mouth for the lips).
    for (const { kind, feature } of features) {
      const skin =
        kind === "eyes"
          ? ellipseFeature(
              feature.center.x,
              feature.center.y + box.height * 0.17,
              feature.rx,
              feature.ry,
            )
          : ellipseFeature(
              feature.center.x - box.width * 0.3,
              feature.center.y - box.height * 0.03,
              feature.rx,
              feature.ry,
            );
      drawFeatureCutout(args, kind, skin, {
        cx: feature.center.x,
        cy: feature.center.y,
        width: naturalCutoutWidth(kind, feature) * 1.35,
        angle: feature.angle,
      });
    }

    // Locked features stick to your face at wherever you blinked them in —
    // box-relative, so they ride along as you move (Mr. Potato Head mode).
    for (const [index, lock] of game.locked.entries()) {
      const { kind, feature } = features[index];
      drawFeatureCutout(args, kind, feature, {
        cx: box.cx + lock.dx * box.width,
        cy: box.cy + lock.dy * box.width,
        width: naturalCutoutWidth(kind, feature),
        angle: box.angle,
      });
    }

    if (game.stage < features.length) {
      // The current feature falls down the screen on a loop; blink to lock
      // it wherever it is right now.
      const FALL_MS = 2600;
      const { kind, feature } = features[game.stage];
      const fallY = (((timeMs - game.cycleStartMs) % FALL_MS) / FALL_MS) * height;
      const fallX = feature.center.x;
      drawFeatureCutout(args, kind, feature, {
        cx: fallX,
        cy: fallY,
        width: naturalCutoutWidth(kind, feature),
        angle: box.angle,
      });

      const openness =
        (face.leftEye.ry / Math.max(face.leftEye.rx, 1) +
          face.rightEye.ry / Math.max(face.rightEye.rx, 1)) /
        2;
      if (face.tracked && game.eyesClosed && openness > 0.22) game.eyesClosed = false;
      if (face.tracked && !game.eyesClosed && openness < 0.16) {
        game.eyesClosed = true;
        game.locked.push({ dx: (fallX - box.cx) / box.width, dy: (fallY - box.cy) / box.width });
        game.stage += 1;
        game.cycleStartMs = timeMs;
      }

      ctx.textAlign = "center";
      ctx.font = `700 ${Math.round(height * 0.028)}px -apple-system, sans-serif`;
      ctx.fillStyle = "#ffffff";
      const names = ["left eye", "right eye", "lips"];
      ctx.fillText(`blink to place your ${names[game.stage]}`, width / 2, height * 0.06);
    } else {
      drawEmoji(ctx, "🎉", width / 2, height * 0.12, width * 0.2, 0);
      ctx.textAlign = "center";
      ctx.font = `400 ${Math.round(height * 0.02)}px -apple-system, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("a masterpiece — tap to try again", width / 2, height * 0.2);
    }
  },
};

const DO_HZ = 261.63;

const singState = {
  lastTap: -1,
  note: 0,
  wallStartMs: 0,
  ballPos: -2,
  winUntil: 0,
  flashUntil: 0,
};

const faceDropState = {
  lastTap: -1,
  stage: 0,
  locked: [] as { dx: number; dy: number }[],
  cycleStartMs: 0,
  eyesClosed: false,
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

// Pictures an 18-month-old might know the word for. Tap anywhere to
// advance. Words must exist in the generated image sets (keep in sync with
// scripts/generate-flashcard-images.mjs); color cards draw a swatch. The
// deck shuffles once per camera session (module load) so the order varies.
const PICTURE_WORDS = [
  "dog",
  "cat",
  "ball",
  "banana",
  "apple",
  "water",
  "milk",
  "baby",
  "tomato",
  "cucumber",
  "door",
  "chair",
  "bed",
  "cow",
  "pig",
  "horse",
  "sheep",
  "duck",
  "chicken",
  "carrot",
  "pasta",
  "bread",
  "cheese",
  "egg",
  "strawberry",
  "grapes",
  "orange",
  "car",
  "bus",
  "train",
  "book",
  "star",
  "moon",
  "sun",
  "tree",
  "flower",
  "fish",
  "bird",
  "shoe",
  "hat",
  "spoon",
  "nose",
  "ear",
  "hand",
  "foot",
  "sock",
  "cup",
  "bowl",
  "plate",
  "bottle",
  "phone",
  "keys",
  "bath",
  "brush",
  "cookie",
  "cake",
  "juice",
  "corn",
  "peas",
  "bear",
  "lion",
  "elephant",
  "monkey",
  "rabbit",
  "frog",
  "bee",
  "mouse",
  "butterfly",
  "snail",
  "worm",
  "bike",
  "boat",
  "plane",
  "truck",
  "tractor",
  "balloon",
  "teddy bear",
  "doll",
  "blocks",
  "cloud",
  "snow",
];

const CARD_COLORS = [
  "#2874a6",
  "#af601a",
  "#239b56",
  "#6c3483",
  "#1e8449",
  "#154360",
  "#7d6608",
  "#884ea0",
  "#943126",
  "#21618c",
  "#117864",
  "#6e2c00",
  "#5b2c6f",
  "#1f618d",
  "#9a7d0a",
  "#0e6251",
  "#78281f",
  "#4a235a",
];

const FLASHCARDS: { word: string; background: string; swatch?: string }[] = shuffle([
  ...PICTURE_WORDS.map((word, i) => ({ word, background: CARD_COLORS[i % CARD_COLORS.length] })),
  { word: "red", background: "#34495e", swatch: "#e74c3c" },
  { word: "blue", background: "#34495e", swatch: "#3498db" },
  { word: "green", background: "#34495e", swatch: "#2ecc71" },
  { word: "yellow", background: "#34495e", swatch: "#f1c40f" },
]);

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

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
  drawImageCover(ctx, image, width, height);
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
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

/** The dest.width that renders a feature's cutout at natural 1:1 size. */
function naturalCutoutWidth(kind: keyof MaskStretch, feature: FaceFeature): number {
  return 2 * feature.rx * BASE_EXPAND[kind] * 1.3;
}

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
  // Uniform scale anchored to the UNSTRETCHED feature size: the patch keeps
  // YOUR feature's aspect ratio, and adjusting the mask looseness only
  // reshapes the hole — dividing by the stretched patch size instead would
  // zoom the imagery as the mask grows (on-device-caught).
  const nominalWidth = 2 * feature.rx * BASE_EXPAND[kind] * 1.3;
  const scale = dest.width / Math.max(nominalWidth, 1);
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
