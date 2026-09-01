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

import { ANIMAL_FACE_IMAGES } from "./animal-faces.generated.ts";
import { FILTER_BACKDROPS } from "./backdrops.generated.ts";
import { FLASHCARD_IMAGES_CARTOON } from "./flashcards-cartoon.generated.ts";
import { FLASHCARD_IMAGES_ENCYCLOPAEDIA } from "./flashcards-encyclopaedia.generated.ts";
import { FLASHCARD_IMAGES_PHOTO } from "./flashcards-photo.generated.ts";
import { FILTER_PICKER } from "./picker.ts";
import { foldedSemitoneOffset, SOLFEGE } from "./pitch.ts";
import { ellipseFeature, type FaceFeature, type FaceGeometry } from "./face-geometry.ts";

/** How loose the cutout masks are around the tracked features, per feature
 * kind — 1 is the default; the pipeline lets the user drag these. */
export type MaskStretch = {
  eyes: { x: number; y: number };
  nose: { x: number; y: number };
  lips: { x: number; y: number };
};

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
    dest?: {
      cx: number;
      cy: number;
      width: number;
      angle: number;
      /** >1 = softer, wider feather (skin patches want ~2). */
      softness?: number;
      alpha?: number;
    } | null,
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
  /** Beep a sine tone (WebAudio) — the sing ladder's note playback. */
  playTone: (hz: number, durationMs: number) => void;
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
  /** Cycled by the second mode button (FILTER_MODES_2 — the flashcards'
   * background). */
  modeIndex2: number;
  /** The most recent settings-row action button press (FILTER_ACTIONS /
   * a dynamic filter's `actions`); seq increments per press. */
  action: { id: string; seq: number } | null;
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
  /** The most recent plain tap (canvas pixels) — seq increments per tap, so
   * filters can react positionally (the sing ladder plays notes). Every tap
   * also still increments backgroundIndex. */
  tap: { x: number; y: number; seq: number } | null;
  /** A drag the pipeline did not consume (see the adjust-mode button: in
   * "holes" mode, drags starting on a feature cutout reshape that mask and
   * drags elsewhere arrive here; in the scale modes every drag is
   * consumed): canvas-pixel start point and current deltas, `active` while
   * the finger is down, seq increments per drag so filters can snapshot
   * state at its start. */
  drag: {
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    active: boolean;
    seq: number;
  } | null;
  /** The user's global scale tuning (the adjust-mode button + drags):
   * featureScale grows every cutout in place (centers fixed); faceScale
   * scales the whole face — the cutout helper applies both to in-place
   * masks and featureScale to remapped ones; filters that lay a face out
   * themselves (flashcards, potato) multiply their layout by faceScale. */
  adjust: { featureScale: number; faceScale: number };
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
    playTone,
  };
  return args;
}

// One lazily-created output context for tone playback; resumed on every
// call because iOS suspends it until a user gesture has happened.
let toneContext: AudioContext | null = null;

function playTone(hz: number, durationMs: number) {
  try {
    toneContext = toneContext || new AudioContext();
    void toneContext.resume();
    const oscillator = toneContext.createOscillator();
    const gain = toneContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = hz;
    const now = toneContext.currentTime;
    const seconds = durationMs / 1000;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    oscillator.connect(gain).connect(toneContext.destination);
    oscillator.start(now);
    oscillator.stop(now + seconds + 0.05);
  } catch {
    // No audio output available — taps just do nothing audible.
  }
}

/** A project-authored filter: the `filters/<name>.filter.js` repo file must
 * be a single JS object expression of this shape. See evaluateDynamicFilter. */
export type DynamicFilterDefinition = {
  label: string;
  emoji: string;
  /** Optional mode labels — the pipeline shows its cycle button for them. */
  modes?: string[];
  /** Optional one-shot buttons for the settings row; presses arrive as
   * args.action. */
  actions?: { id: string; label: string }[];
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
  // Tolerate a trailing semicolon (formatters add one; the parenthesized
  // return would otherwise turn it into a syntax error).
  const expression = source.trim().replace(/;$/, "");
  // eslint-disable-next-line no-new-func -- evaluating project-authored filter code is the feature
  const definition = new Function(`"use strict"; return (
${expression}
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
    const spread = args.adjust.faceScale;
    const leftEye = at(-0.16 * spread, -0.14 * spread);
    const rightEye = at(0.16 * spread, -0.14 * spread);
    const lips = at(0, 0.14 * spread);
    // face.leftEye is the canvas-left eye (geometry normalizes the mirror
    // swap), so your left-on-screen eye lands on the potato's left.
    drawFeatureCutout(args, "eyes", args.face.leftEye, {
      cx: leftEye.x,
      cy: leftEye.y,
      width: size * 0.28 * spread,
      angle: tilt,
    });
    drawFeatureCutout(args, "eyes", args.face.rightEye, {
      cx: rightEye.x,
      cy: rightEye.y,
      width: size * 0.28 * spread,
      angle: tilt,
    });
    drawFeatureCutout(args, "lips", args.face.lips, {
      cx: lips.x,
      cy: lips.y,
      width: size * 0.38 * spread,
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
    // A photorealistic animal face worn as a mask: it follows your head
    // (position, roll, size), and YOUR eyes and mouth are remapped onto the
    // ANIMAL's eye and mouth positions (hand-tuned anchors per image).
    const animal = ANIMAL_FACES[args.modeIndex % ANIMAL_FACES.length];
    const image = cachedImage(`animal-${animal.id}`, ANIMAL_FACE_IMAGES[animal.id]);
    const { box } = args.face;
    const angle = box.angle;
    const width = Math.max(box.width, box.height * 0.8) * 2.1 * animal.scale;
    if (image) {
      const height = width * (image.naturalHeight / image.naturalWidth);
      args.ctx.save();
      args.ctx.translate(box.cx, box.cy);
      args.ctx.rotate(angle);
      args.ctx.drawImage(image, -width / 2, -height / 2, width, height);
      args.ctx.restore();
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const at = (anchor: { x: number; y: number }) => {
        const dx = (anchor.x - 0.5) * width;
        const dy = (anchor.y - 0.5) * height;
        return { x: box.cx + dx * cos - dy * sin, y: box.cy + dx * sin + dy * cos };
      };
      const leftEye = at(animal.leftEye);
      const rightEye = at(animal.rightEye);
      const mouth = at(animal.mouth);
      drawFeatureCutout(args, "eyes", args.face.leftEye, {
        cx: leftEye.x,
        cy: leftEye.y,
        width: width * animal.eyeWidth,
        angle,
      });
      drawFeatureCutout(args, "eyes", args.face.rightEye, {
        cx: rightEye.x,
        cy: rightEye.y,
        width: width * animal.eyeWidth,
        angle,
      });
      drawFeatureCutout(args, "lips", args.face.lips, {
        cx: mouth.x,
        cy: mouth.y,
        width: width * animal.mouthWidth,
        angle,
      });
    } else {
      // Image still decoding: plain masked face so the frame isn't empty.
      drawFaceCutoutsInPlace(args);
    }
  },
  flashcards: (args) => {
    const { ctx, width, height, face } = args;
    const deck = flashcardDeck;
    if (deck.seed === null) deck.seed = Date.now() % 1000;
    if (deck.order === null) deck.order = seededOrder(FLASHCARDS.length, deck.seed);

    // Settings-row actions: ↺ replays the same seed from card one; 🎲 rolls
    // a new seed. Taps on the scene just advance the card (backgroundIndex).
    if (args.action && args.action.seq !== deck.lastActionSeq) {
      deck.lastActionSeq = args.action.seq;
      if (args.action.id === "replay") {
        deck.baseIndex = args.backgroundIndex;
      } else if (args.action.id === "reroll") {
        deck.seed = Date.now() % 1000;
        deck.order = seededOrder(FLASHCARDS.length, deck.seed);
        deck.baseIndex = args.backgroundIndex;
      }
    }
    const cardStep = args.backgroundIndex - deck.baseIndex;
    const card =
      FLASHCARDS[
        deck.order[((cardStep % deck.order.length) + deck.order.length) % deck.order.length]
      ];
    const style = FLASHCARD_STYLES[args.modeIndex % FLASHCARD_STYLES.length];
    const backgroundOption = FLASHCARD_BACKGROUNDS[args.modeIndex2 % FLASHCARD_BACKGROUNDS.length];

    ctx.fillStyle =
      backgroundOption.color === null
        ? card.background
        : backgroundOption.color === "rainbow"
          ? `hsl(${(cardStep * 47 + 200) % 360} 65% 45%)`
          : backgroundOption.color;
    ctx.fillRect(0, 0, width, height);
    const chromeColor = backgroundOption.darkChrome
      ? "rgba(20,20,25,0.75)"
      : "rgba(255,255,255,0.85)";

    // The picture of the thing — no word on the card; the grown-up says it.
    if (card.swatch) {
      ctx.fillStyle = card.swatch;
      ctx.beginPath();
      ctx.arc(width / 2, height * 0.62, width * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = width * 0.015;
      ctx.strokeStyle = chromeColor;
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

    // Seed readout (display only — the settings row holds the buttons),
    // drawn below the status bar/clock.
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `600 ${Math.round(height * 0.018)}px -apple-system, sans-serif`;
    ctx.fillStyle = chromeColor;
    ctx.fillText(`deck ${String(deck.seed).padStart(3, "0")}`, width / 2, height * 0.085);

    // The grown-up fills the space above the card: eyes and lips pinned to
    // a big face zone (patches keep the head's roll and grow as you lean
    // in). The adjust button's "face" mode (args.adjust.faceScale) scales
    // this whole layout; spacing is deliberately tight — no phantom nose
    // gap.
    const zoom = Math.min(1.8, Math.max(0.6, args.facePose.scale)) * args.adjust.faceScale;
    const angle = face.box.angle;
    // Face anchor: centered over the space between the top and the card.
    const anchorY = height * 0.23;
    const eyeY = anchorY - height * 0.05 * zoom;
    drawFeatureCutout(args, "eyes", face.leftEye, {
      cx: width / 2 - width * 0.15 * zoom,
      cy: eyeY,
      width: width * 0.26 * zoom,
      angle,
    });
    drawFeatureCutout(args, "eyes", face.rightEye, {
      cx: width / 2 + width * 0.15 * zoom,
      cy: eyeY,
      width: width * 0.26 * zoom,
      angle,
    });
    drawFeatureCutout(args, "lips", face.lips, {
      cx: width / 2,
      cy: anchorY + height * 0.075 * zoom,
      width: width * 0.36 * zoom,
      angle,
    });
  },
  sing: (args) => {
    const { ctx, width, height, face, timeMs } = args;
    const game = singState;
    const groundY = height * 0.85;
    const horizonY = height * 0.33;
    // Pitch 0 (do) sits ON the road; the ball can never go below ground.
    const yFor = (semitone: number) => groundY - (Math.max(0, semitone) / 12) * (height * 0.42);

    // Taps: on the ladder column they PLAY the note (cycling octave
    // low→mid→high→off); anywhere else they reset the game.
    if (args.tap && args.tap.seq !== game.lastTapSeq) {
      game.lastTapSeq = args.tap.seq;
      if (args.tap.x < width * 0.18) {
        let nearest = 0;
        for (let i = 0; i < SOLFEGE.length; i++) {
          if (
            Math.abs(args.tap.y - yFor(SOLFEGE[i].semitone)) <
            Math.abs(args.tap.y - yFor(SOLFEGE[nearest].semitone))
          ) {
            nearest = i;
          }
        }
        game.octaveCycle[nearest] = ((game.octaveCycle[nearest] || 0) + 1) % 4;
        const cycle = game.octaveCycle[nearest];
        if (cycle !== 0) {
          const octave = [0, 0.5, 1, 2][cycle];
          args.helpers.playTone(DO_HZ * octave * 2 ** (SOLFEGE[nearest].semitone / 12), 700);
        }
      } else {
        game.note = 0;
        game.wallStartMs = timeMs;
        game.history = [];
        game.winUntil = 0;
        game.flashUntil = 0;
      }
    }

    ctx.drawImage(args.frame, 0, 0);
    ctx.fillStyle = "rgba(8, 10, 24, 0.5)";
    ctx.fillRect(0, 0, width, height);

    // 3/4-view road: a trapezoid to a vanishing point, with depth stripes.
    const vanishX = width * 0.62;
    const roadHalfNear = width * 0.34;
    const roadX = (depth: number) => vanishX + (width * 0.5 - vanishX) * (1 - depth);
    const roadHalf = (depth: number) => roadHalfNear * (1 - depth * 0.92);
    const roadY = (depth: number) => groundY - (groundY - horizonY) * depth;
    ctx.beginPath();
    ctx.moveTo(roadX(0) - roadHalf(0), roadY(0) + height * 0.06);
    ctx.lineTo(roadX(1) - roadHalf(1), roadY(1));
    ctx.lineTo(roadX(1) + roadHalf(1), roadY(1));
    ctx.lineTo(roadX(0) + roadHalf(0), roadY(0) + height * 0.06);
    ctx.closePath();
    ctx.fillStyle = "#2f3542cc";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    for (const depth of [0.2, 0.45, 0.65, 0.8, 0.9]) {
      ctx.beginPath();
      ctx.moveTo(roadX(depth) - roadHalf(depth), roadY(depth));
      ctx.lineTo(roadX(depth) + roadHalf(depth), roadY(depth));
      ctx.stroke();
    }

    const target = SOLFEGE[game.note];
    const targetY = yFor(target.semitone);
    const toleranceSemitones = 0.5;
    const gapHalf = (toleranceSemitones / 12) * height * 0.42 + height * 0.014;

    // The ball rides your sung pitch, octave-folded around the TARGET note,
    // stabilised with a short median window so jitter doesn't bounce you.
    const hz = args.pitchHz;
    if (hz !== null) {
      game.history.push({
        atMs: timeMs,
        pos: target.semitone + foldedSemitoneOffset(hz, DO_HZ * 2 ** (target.semitone / 12)),
      });
    }
    game.history = game.history.filter((entry) => timeMs - entry.atMs < 700);
    const recent = game.history.map((entry) => entry.pos).sort((a, b) => a - b);
    const median = recent.length ? recent[Math.floor(recent.length / 2)] : 0;
    const voiced = recent.length >= 3;
    const goalPos = voiced ? median : 0;
    game.ballPos += (goalPos - game.ballPos) * 0.2;
    const ballX = width * 0.42;
    // Resting on the road the ball does a happy little hop.
    const hop =
      !voiced && game.ballPos < 0.4 ? Math.abs(Math.sin(timeMs / 260)) * height * 0.015 : 0;
    const ballY = yFor(game.ballPos) - hop;

    // Ladder of note names, kept in a column along the left.
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const [index, note] of SOLFEGE.entries()) {
      const active = index === game.note;
      ctx.font = `${active ? 700 : 400} ${Math.round(height * (active ? 0.032 : 0.022))}px -apple-system, sans-serif`;
      ctx.fillStyle = active ? "#ffe066" : "rgba(255,255,255,0.6)";
      ctx.fillText(note.name, width * 0.04, yFor(note.semitone));
    }

    // The wall approaches along the road from the vanishing point: depth 1→0.
    const WALL_MS = 5000;
    const progress = Math.min(1, (timeMs - game.wallStartMs) / WALL_MS);
    const depth = 1 - progress;
    if (game.winUntil > timeMs) {
      drawEmoji(ctx, "🎉", width / 2, height * 0.4, width * 0.5, 0);
    } else {
      // A slab standing on the road, scaled by distance, hole at the target
      // pitch height (also perspective-scaled).
      const scalePerspective = 1 - depth * 0.82;
      const wallCenterX = roadX(depth);
      const wallHalf = roadHalf(depth) * 0.85;
      const wallBottom = roadY(depth);
      const wallTop = wallBottom - (groundY - (yFor(12) - gapHalf * 2)) * scalePerspective;
      const holeCenter = wallBottom - (groundY - targetY) * scalePerspective;
      const holeHalf = gapHalf * scalePerspective * 1.15;
      const wallThickness = width * 0.02 * scalePerspective;
      ctx.fillStyle = game.flashUntil > timeMs ? "rgba(231,76,60,0.85)" : "rgba(88,214,141,0.85)";
      ctx.fillRect(
        wallCenterX - wallHalf,
        wallTop,
        wallHalf * 2,
        Math.max(0, holeCenter - holeHalf - wallTop),
      );
      ctx.fillRect(
        wallCenterX - wallHalf,
        holeCenter + holeHalf,
        wallHalf * 2,
        Math.max(0, wallBottom - (holeCenter + holeHalf)),
      );
      // A darker extruded side face sells the 3/4 view.
      ctx.fillStyle = game.flashUntil > timeMs ? "rgba(160,50,40,0.85)" : "rgba(50,140,90,0.85)";
      ctx.fillRect(
        wallCenterX + wallHalf,
        wallTop - wallThickness,
        wallThickness,
        wallBottom - wallTop + wallThickness,
      );
      // Outline the hole so the target height reads at a glance.
      ctx.strokeStyle = "#ffe066";
      ctx.lineWidth = Math.max(2, 4 * scalePerspective);
      ctx.strokeRect(wallCenterX - wallHalf, holeCenter - holeHalf, wallHalf * 2, holeHalf * 2);
      if (progress >= 1) {
        const held = game.history
          .filter((entry) => timeMs - entry.atMs < 500)
          .map((entry) => entry.pos)
          .sort((a, b) => a - b);
        const heldMedian = held.length >= 3 ? held[Math.floor(held.length / 2)] : null;
        if (heldMedian !== null && Math.abs(heldMedian - target.semitone) <= toleranceSemitones) {
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

    // The ball is your actual mouth, rolling down the road.
    ctx.beginPath();
    ctx.arc(ballX, ballY, width * 0.075, 0, Math.PI * 2);
    ctx.fillStyle = voiced ? "rgba(255,224,102,0.4)" : "rgba(255,255,255,0.25)";
    ctx.fill();
    drawFeatureCutout(args, "lips", face.lips, {
      cx: ballX,
      cy: ballY,
      width: width * 0.13,
      angle: 0,
    });

    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(height * 0.035)}px -apple-system, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`sing ${target.name}`, width / 2, height * 0.06);
    ctx.font = `400 ${Math.round(height * 0.018)}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(
      hz === null ? "any octave — tap a note name to hear it" : `${Math.round(hz)}Hz`,
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
      { kind: "nose", feature: face.nose },
      { kind: "lips", feature: face.lips },
    ];

    // Blank the face: layer two soft skin samples over each feature's home
    // spot, taken from either side of it (cheek/temple), so the fill blends
    // stubble and shading instead of stamping one obvious patch.
    for (const { kind, feature } of features) {
      const dy = kind === "lips" ? -box.height * 0.02 : box.height * 0.15;
      const sources = [
        ellipseFeature(
          feature.center.x - box.width * 0.24,
          feature.center.y + dy,
          feature.rx,
          feature.ry,
          feature.angle,
        ),
        ellipseFeature(
          feature.center.x + box.width * 0.24,
          feature.center.y + dy,
          feature.rx,
          feature.ry,
          feature.angle,
        ),
      ];
      for (const [index, skin] of sources.entries()) {
        drawFeatureCutout(args, kind, skin, {
          cx: feature.center.x,
          cy: feature.center.y,
          width: naturalCutoutWidth(kind, feature) * 1.4,
          angle: feature.angle,
          softness: 2.2,
          alpha: index === 0 ? 1 : 0.55,
        });
      }
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
      const names = ["left eye", "right eye", "nose", "lips"];
      ctx.fillText(`blink to place your ${names[game.stage]}`, width / 2, height * 0.06);
    } else {
      drawEmoji(ctx, "🎉", width / 2, height * 0.12, width * 0.2, 0);
      ctx.textAlign = "center";
      ctx.font = `400 ${Math.round(height * 0.02)}px -apple-system, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("a masterpiece — tap to try again", width / 2, height * 0.2);
    }
  },
  // Written strictly against the args/helpers surface — this drawer doubles
  // as the reference for project-authored filters (docs/project-filters.md).
  "paper-toss": (args) => {
    const { ctx, width, height, face, timeMs } = args;
    const game = paperTossState;
    if (args.tap && args.tap.seq !== game.lastTapSeq) {
      game.lastTapSeq = args.tap.seq;
      game.score = 0;
      game.phase = "aim";
      game.binX = null;
    }
    if (game.binX === null) {
      // Pseudo-random per attempt without Math.random: hash the clock.
      const seed = Math.abs(Math.sin(timeMs * 12.9898) * 43758.5453) % 1;
      game.binX = width * (0.25 + seed * 0.5);
      game.binDepth = 0.35 + ((seed * 7919) % 1) * 0.45;
      game.windX = (((seed * 104729) % 1) - 0.5) * 2;
    }

    ctx.drawImage(args.frame, 0, 0);

    // A floor plane for depth; the bin stands on it, smaller when further.
    const groundNearY = height * 0.9;
    const groundFarY = height * 0.45;
    ctx.fillStyle = "rgba(30, 34, 44, 0.35)";
    ctx.fillRect(0, groundFarY, width, groundNearY - groundFarY + height * 0.1);
    const binY = groundNearY - (groundNearY - groundFarY) * game.binDepth;
    const binScale = 1 - game.binDepth * 0.6;
    drawEmoji(ctx, "🗑️", game.binX, binY, width * 0.24 * binScale, 0);

    // Wind indicator.
    ctx.textAlign = "center";
    ctx.font = `400 ${Math.round(height * 0.02)}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const windGlyph = game.windX > 0.15 ? "💨→" : game.windX < -0.15 ? "←💨" : "·";
    ctx.fillText(`wind ${windGlyph}`, width / 2, height * 0.13);
    ctx.font = `700 ${Math.round(height * 0.03)}px -apple-system, sans-serif`;
    ctx.fillText(`🏀 ${game.score}`, width * 0.85, height * 0.06);

    const restX = width / 2;
    const restY = height * 0.94;
    const mouthOpenness = face.lips.ry / Math.max(face.lips.rx, 1);

    if (game.phase === "aim") {
      // The paper waits at the bottom; open your mouth to throw. How wide
      // you open it decides how far the paper flies.
      drawPaperBall(ctx, restX, restY, width * 0.05);
      if (face.tracked && mouthOpenness < 0.5) game.mouthWasOpen = false;
      if (face.tracked && !game.mouthWasOpen && mouthOpenness > 0.72) {
        game.mouthWasOpen = true;
        game.phase = "flying";
        game.throwStartMs = timeMs;
        game.throwDepth = Math.min(1, Math.max(0.15, (mouthOpenness - 0.55) * 1.9));
      }
      ctx.font = `400 ${Math.round(height * 0.02)}px -apple-system, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText("open WIDE to throw — wider throws further", width / 2, height * 0.17);
    } else if (game.phase === "flying") {
      const FLIGHT_MS = 1100;
      const progress = Math.min(1, (timeMs - game.throwStartMs) / FLIGHT_MS);
      const depth = game.throwDepth * progress;
      const paperY0 = restY - (groundNearY - groundFarY) * depth;
      const arc = Math.sin(progress * Math.PI) * height * 0.28 * game.throwDepth;
      const paperX = restX + game.windX * width * 0.22 * progress;
      const paperScale = 1 - depth * 0.6;
      drawPaperBall(ctx, paperX, paperY0 - arc, width * 0.05 * paperScale);
      if (progress >= 1) {
        const landedNearBin =
          Math.abs(paperX - game.binX) < width * 0.09 * binScale + width * 0.02 &&
          Math.abs(game.throwDepth - game.binDepth) < 0.14;
        game.phase = "landed";
        game.landedMs = timeMs;
        game.landedHit = landedNearBin;
        game.landedX = paperX;
        game.landedY = paperY0 - height * 0.01;
      }
    }
    if (game.phase === "landed") {
      if (game.landedHit) {
        drawEmoji(ctx, "🎉", game.binX, binY - height * 0.06, width * 0.16, 0);
      } else {
        drawPaperBall(ctx, game.landedX, game.landedY, width * 0.045);
        ctx.font = `400 ${Math.round(height * 0.02)}px -apple-system, sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText("missed!", game.landedX, game.landedY - height * 0.04);
      }
      if (timeMs - game.landedMs > 900) {
        if (game.landedHit) game.score += 1;
        game.phase = "aim";
        game.binX = null;
        game.mouthWasOpen = true;
      }
    }
  },
};

const DO_HZ = 261.63;

const singState = {
  lastTapSeq: -1,
  note: 0,
  wallStartMs: 0,
  ballPos: 0,
  winUntil: 0,
  flashUntil: 0,
  history: [] as { atMs: number; pos: number }[],
  octaveCycle: [] as number[],
};

const faceDropState = {
  lastTap: -1,
  stage: 0,
  locked: [] as { dx: number; dy: number }[],
  cycleStartMs: 0,
  eyesClosed: false,
};

const paperTossState = {
  lastTapSeq: -1,
  score: 0,
  phase: "aim" as "aim" | "flying" | "landed",
  binX: null as number | null,
  binDepth: 0.5,
  windX: 0,
  throwStartMs: 0,
  throwDepth: 0.5,
  mouthWasOpen: false,
  landedMs: 0,
  landedHit: false,
  landedX: 0,
  landedY: 0,
};

/** A crumpled paper ball: white disc with a few crease arcs. */
function drawPaperBall(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#f2f3f4";
  ctx.fill();
  ctx.strokeStyle = "rgba(120,120,125,0.6)";
  ctx.lineWidth = Math.max(1, radius * 0.08);
  for (const [a, b, r] of [
    [0.2, 1.9, 0.55],
    [2.4, 4.2, 0.65],
    [4.6, 6.0, 0.45],
  ]) {
    ctx.beginPath();
    ctx.arc(cx + radius * 0.15, cy - radius * 0.1, radius * r, a, b);
    ctx.stroke();
  }
  ctx.restore();
}

// Flashcard picture styles the mode button cycles through. Styles with no
// images yet (photo, until an Unsplash key exists) stay hidden.
const FLASHCARD_STYLES = [
  // Order matters: the first style is the default (modeIndex 0).
  { id: "encyclopaedia", label: "📷 Encyclopaedia", images: FLASHCARD_IMAGES_ENCYCLOPAEDIA },
  { id: "cartoon", label: "🖍️ Cartoon", images: FLASHCARD_IMAGES_CARTOON },
  { id: "photo", label: "🌍 Real photos", images: FLASHCARD_IMAGES_PHOTO },
].filter((style) => Object.keys(style.images).length > 0);

/** Mode labels per filter id; the pipeline shows a cycle button when a
 * filter has more than one. */
/** The Animal mask filter's cast. Anchor coordinates are normalized [0..1]
 * positions of each animal's eyes and mouth WITHIN its generated portrait,
 * hand-tuned by looking at the images (regenerating the art means
 * re-checking these). eyeWidth/mouthWidth are cutout sizes as fractions of
 * the drawn face width; scale adjusts how large the head sits on yours. */
const ANIMAL_FACES = [
  {
    id: "cat",
    label: "🐱 Cat",
    leftEye: { x: 0.36, y: 0.475 },
    rightEye: { x: 0.645, y: 0.475 },
    mouth: { x: 0.5, y: 0.71 },
    eyeWidth: 0.13,
    mouthWidth: 0.2,
    scale: 1,
  },
  {
    id: "dog",
    label: "🐶 Dog",
    leftEye: { x: 0.375, y: 0.455 },
    rightEye: { x: 0.625, y: 0.455 },
    mouth: { x: 0.5, y: 0.8 },
    eyeWidth: 0.12,
    mouthWidth: 0.2,
    scale: 1.05,
  },
  {
    id: "goat",
    label: "🐐 Goat",
    leftEye: { x: 0.295, y: 0.42 },
    rightEye: { x: 0.705, y: 0.42 },
    mouth: { x: 0.5, y: 0.795 },
    eyeWidth: 0.12,
    mouthWidth: 0.18,
    scale: 1,
  },
  {
    id: "tiger",
    label: "🐯 Tiger",
    leftEye: { x: 0.365, y: 0.4 },
    rightEye: { x: 0.635, y: 0.4 },
    mouth: { x: 0.5, y: 0.72 },
    eyeWidth: 0.12,
    mouthWidth: 0.22,
    scale: 1.1,
  },
  {
    id: "bear",
    label: "🐻 Bear",
    leftEye: { x: 0.36, y: 0.4 },
    rightEye: { x: 0.64, y: 0.4 },
    mouth: { x: 0.5, y: 0.71 },
    eyeWidth: 0.11,
    mouthWidth: 0.2,
    scale: 1.1,
  },
  {
    id: "monkey",
    label: "🐵 Monkey",
    leftEye: { x: 0.4, y: 0.355 },
    rightEye: { x: 0.6, y: 0.355 },
    mouth: { x: 0.5, y: 0.62 },
    eyeWidth: 0.11,
    mouthWidth: 0.18,
    scale: 1,
  },
  {
    id: "gorilla",
    label: "🦍 Gorilla",
    leftEye: { x: 0.4, y: 0.4 },
    rightEye: { x: 0.6, y: 0.4 },
    mouth: { x: 0.5, y: 0.72 },
    eyeWidth: 0.1,
    mouthWidth: 0.2,
    scale: 1.1,
  },
  {
    id: "lion",
    label: "🦁 Lion",
    leftEye: { x: 0.38, y: 0.41 },
    rightEye: { x: 0.615, y: 0.41 },
    mouth: { x: 0.5, y: 0.67 },
    eyeWidth: 0.1,
    mouthWidth: 0.18,
    scale: 1.2,
  },
  {
    id: "horse",
    label: "🐴 Horse",
    leftEye: { x: 0.27, y: 0.44 },
    rightEye: { x: 0.73, y: 0.44 },
    mouth: { x: 0.5, y: 0.93 },
    eyeWidth: 0.12,
    mouthWidth: 0.2,
    scale: 1.15,
  },
  {
    id: "fox",
    label: "🦊 Fox",
    leftEye: { x: 0.365, y: 0.5 },
    rightEye: { x: 0.645, y: 0.5 },
    mouth: { x: 0.49, y: 0.8 },
    eyeWidth: 0.12,
    mouthWidth: 0.18,
    scale: 1,
  },
  {
    id: "mouse",
    label: "🐭 Mouse",
    leftEye: { x: 0.335, y: 0.47 },
    rightEye: { x: 0.66, y: 0.47 },
    mouth: { x: 0.5, y: 0.8 },
    eyeWidth: 0.12,
    mouthWidth: 0.18,
    scale: 1,
  },
];

export const FILTER_MODES: Record<string, string[]> = {
  cat: ANIMAL_FACES.map((animal) => animal.label),
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
  "honey",
  "toast",
  "peanut butter",
  "broccoli",
  "ice lolly",
  "ice cream",
  "pear",
  "kiwi",
  "eye",
  "chin",
  "penguin",
  "giraffe",
  "piano",
  "taxi",
  "scooter",
  "digger",
  "fire engine",
  "motorbike",
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

const FLASHCARDS: { word: string; background: string; swatch?: string }[] = [
  ...PICTURE_WORDS.map((word, i) => ({ word, background: CARD_COLORS[i % CARD_COLORS.length] })),
  { word: "red", background: "#34495e", swatch: "#e74c3c" },
  { word: "blue", background: "#34495e", swatch: "#3498db" },
  { word: "green", background: "#34495e", swatch: "#2ecc71" },
  { word: "yellow", background: "#34495e", swatch: "#f1c40f" },
];

// The deck order comes from a small visible seed, so a practice run can be
// replayed exactly: ↺ restarts the same order, 🎲 rolls a new seed.
const flashcardDeck = {
  seed: null as number | null,
  baseIndex: 0,
  order: null as number[] | null,
  lastActionSeq: -1,
};

/** Deterministic Fisher–Yates from a numeric seed (mulberry32). */
function seededOrder(count: number, seed: number): number[] {
  let state = seed + 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const FLASHCARD_BACKGROUNDS: {
  label: string;
  /** null = the per-card palette colour. */
  color: string | null;
  /** Swatch cards need a visible outline on light backgrounds. */
  darkChrome?: boolean;
}[] = [
  { label: "🎨 Colours", color: null },
  { label: "⬜ White", color: "#ffffff", darkChrome: true },
  { label: "⬛ Black", color: "#0b0b0f" },
  { label: "📜 Cream", color: "#f6f1e7", darkChrome: true },
  { label: "🌈 Rainbow", color: "rainbow" },
];

/** A second, independent mode group (its own button). */
export const FILTER_MODES_2: Record<string, string[]> = {
  flashcards: FLASHCARD_BACKGROUNDS.map((background) => background.label),
};

/** One-shot action buttons rendered in the settings row; presses arrive as
 * args.action. */
export const FILTER_ACTIONS: Record<string, { id: string; label: string }[]> = {
  flashcards: [
    { id: "replay", label: "↺ replay" },
    { id: "reroll", label: "🎲 reseed" },
  ],
};

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
const BASE_EXPAND: Record<keyof MaskStretch, number> = { eyes: 1.45, nose: 1.3, lips: 1.25 };

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
  dest: {
    cx: number;
    cy: number;
    width: number;
    angle: number;
    softness?: number;
    alpha?: number;
  } | null,
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
  const maskScale = 6 * (dest?.softness || 1);
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

  const { featureScale, faceScale } = args.adjust;
  if (dest === null) {
    if (featureScale === 1 && faceScale === 1) {
      ctx.drawImage(scratch, 0, 0, sw, sh, sx, sy, sw, sh);
      args.featureHits.push({
        kind,
        cx: sx + sw / 2,
        cy: sy + sh / 2,
        radius: Math.max(sw, sh) / 2,
      });
      return;
    }
    // Adjusted in-place mask: featureScale grows the patch around its own
    // center; faceScale additionally spreads centers from the face's
    // center (the whole face gets bigger).
    const box = args.face.box;
    dest = {
      cx: box.cx + (feature.center.x - box.cx) * faceScale,
      cy: box.cy + (feature.center.y - box.cy) * faceScale,
      width: 2 * feature.rx * BASE_EXPAND[kind] * 1.3 * faceScale,
      angle: feature.angle,
    };
  }
  // Uniform scale anchored to the UNSTRETCHED feature size: the patch keeps
  // YOUR feature's aspect ratio, and adjusting the mask looseness only
  // reshapes the hole — dividing by the stretched patch size instead would
  // zoom the imagery as the mask grows (on-device-caught).
  const nominalWidth = 2 * feature.rx * BASE_EXPAND[kind] * 1.3;
  // featureScale also grows remapped cutouts in place (their dest centers
  // are the filter's business and stay put).
  const scale = (dest.width * featureScale) / Math.max(nominalWidth, 1);
  ctx.save();
  if (dest.alpha !== undefined) ctx.globalAlpha = dest.alpha;
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
