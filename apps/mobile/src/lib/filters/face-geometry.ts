// Face geometry for the camera filters: turns MediaPipe FaceLandmarker's 478
// normalized landmarks into the handful of shapes the filters draw with
// (face box, eye and lip ellipses), all in canvas pixels. Pure math — the
// WebView pipeline (components/filter-camera.tsx) feeds it landmarks and a
// video→canvas cover transform.
//
// Landmark index loops below are from MediaPipe Face Mesh's canonical
// topology (FACEMESH_FACE_OVAL / FACEMESH_LIPS / FACEMESH_LEFT_EYE /
// FACEMESH_RIGHT_EYE in google-ai-edge/mediapipe, Apache-2.0), flattened
// into ordered vertex rings.

export type NormalizedLandmark = { x: number; y: number };

export type Ellipse = { cx: number; cy: number; rx: number; ry: number; angle: number };

export type FaceGeometry = {
  /** Face-oval bounding box center/size, with roll angle in radians. */
  box: { cx: number; cy: number; width: number; height: number; angle: number };
  /** Always the eye that appears on the canvas LEFT — the front-camera
   * mirror swaps the anatomical rings, so filters that remap features onto
   * a character (eyes on the potato) must not trust anatomical naming. */
  leftEye: Ellipse;
  rightEye: Ellipse;
  lips: Ellipse;
  /** False when this is the no-tracker/no-face fallback placement. */
  tracked: boolean;
};

/** How the camera frame maps onto the canvas: cover-crop + optional mirror.
 * scale is canvas px per video px; offsetX/offsetY position the scaled video
 * so it covers the canvas; mirrored flips x (front camera preview). */
export type FrameTransform = {
  videoWidth: number;
  videoHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  mirrored: boolean;
};

export function coverTransform(input: {
  videoWidth: number;
  videoHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  mirrored: boolean;
}): FrameTransform {
  const scale = Math.max(
    input.canvasWidth / input.videoWidth,
    input.canvasHeight / input.videoHeight,
  );
  return {
    ...input,
    scale,
    offsetX: (input.canvasWidth - input.videoWidth * scale) / 2,
    offsetY: (input.canvasHeight - input.videoHeight * scale) / 2,
  };
}

/** Map one normalized (0..1 of the video) landmark into canvas pixels. */
function landmarkToCanvas(
  landmark: NormalizedLandmark,
  t: FrameTransform,
): { x: number; y: number } {
  const videoX = (t.mirrored ? 1 - landmark.x : landmark.x) * t.videoWidth;
  return { x: t.offsetX + videoX * t.scale, y: t.offsetY + landmark.y * t.videoHeight * t.scale };
}

export function faceGeometryFromLandmarks(
  landmarks: NormalizedLandmark[],
  t: FrameTransform,
): FaceGeometry {
  const ring = (indices: number[]) => indices.map((i) => landmarkToCanvas(landmarks[i], t));

  const oval = ring(FACE_OVAL);
  const box = boundingBox(oval);
  // Roll from the line between the eye centers. Under the front-camera
  // mirror the eye rings swap sides and this vector points backwards (~180°
  // off — harness-caught: upside-down potato); roll is an undirected axis,
  // so wrap it into ±90°.
  const left = ringCenter(ring(LEFT_EYE));
  const right = ringCenter(ring(RIGHT_EYE));
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle < -Math.PI / 2) angle += Math.PI;

  // Expansion factors: the eye rings hug the eyelids; the cutouts include
  // lashes and a little skin, but stay tight around the feature.
  const eyeA = ellipseAround(ring(LEFT_EYE), angle, 1.8, 2.4);
  const eyeB = ellipseAround(ring(RIGHT_EYE), angle, 1.8, 2.4);
  const [leftEye, rightEye] = eyeA.cx <= eyeB.cx ? [eyeA, eyeB] : [eyeB, eyeA];
  return {
    box: { ...box, angle },
    leftEye,
    rightEye,
    lips: ellipseAround(ring(LIPS_OUTER), angle, 1.15, 1.5),
    tracked: true,
  };
}

/** Where a face would plausibly be when the tracker has nothing: a centered
 * oval so filters stay alive instead of going blank. */
export function fallbackFaceGeometry(canvasWidth: number, canvasHeight: number): FaceGeometry {
  const cx = canvasWidth / 2;
  const cy = canvasHeight * 0.42;
  const width = canvasWidth * 0.55;
  const height = width * 1.35;
  const eyeY = cy - height * 0.08;
  const eyeDx = width * 0.21;
  const eye = (centerX: number): Ellipse => ({
    cx: centerX,
    cy: eyeY,
    rx: width * 0.16,
    ry: width * 0.1,
    angle: 0,
  });
  return {
    box: { cx, cy, width, height, angle: 0 },
    leftEye: eye(cx - eyeDx),
    rightEye: eye(cx + eyeDx),
    lips: { cx, cy: cy + height * 0.26, rx: width * 0.2, ry: width * 0.11, angle: 0 },
    tracked: false,
  };
}

function boundingBox(points: { x: number; y: number }[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function ringCenter(points: { x: number; y: number }[]) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Ellipse over a landmark ring, measured along/across the face's roll axis
 * and inflated so the cutout comfortably contains the feature. */
function ellipseAround(
  points: { x: number; y: number }[],
  angle: number,
  expandX: number,
  expandY: number,
): Ellipse {
  const center = ringCenter(points);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  let rx = 0;
  let ry = 0;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    rx = Math.max(rx, Math.abs(dx * cos - dy * sin));
    ry = Math.max(ry, Math.abs(dx * sin + dy * cos));
  }
  return { cx: center.x, cy: center.y, rx: rx * expandX, ry: ry * expandY, angle };
}

// MediaPipe Face Mesh canonical index rings (see attribution at top).
// Exported for tests, which build synthetic landmark arrays around them.
export const FACE_LANDMARK_RINGS = {
  faceOval: () => FACE_OVAL,
  leftEye: () => LEFT_EYE,
  rightEye: () => RIGHT_EYE,
  lipsOuter: () => LIPS_OUTER,
};

const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const LIPS_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];
// "Left"/"right" here are image-space (the subject's right eye is on the
// image left for an unmirrored frame; the pipeline mirrors front-camera
// frames before landmarks reach this module, so filters never care).
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
