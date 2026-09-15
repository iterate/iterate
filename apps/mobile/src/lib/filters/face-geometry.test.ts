import { expect, test } from "vitest";
import {
  coverTransform,
  FACE_LANDMARK_RINGS,
  faceGeometryFromLandmarks,
  faceGeometryFromFeatureRings,
  fallbackFaceGeometry,
} from "./face-geometry.ts";

test("cover transform scales the video to cover the canvas, centered", () => {
  // Landscape 200x100 video on a portrait 100x200 canvas: height drives the
  // scale (×2), the doubled width hangs off both sides equally.
  expect(
    coverTransform({
      videoWidth: 200,
      videoHeight: 100,
      canvasWidth: 100,
      canvasHeight: 200,
      mirrored: false,
    }),
  ).toMatchObject({ scale: 2, offsetX: -150, offsetY: 0 });
});

test("landmarks map through the transform, flipped when mirrored", () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.25, y: 0.5 }));
  const square = { videoWidth: 100, videoHeight: 100, canvasWidth: 100, canvasHeight: 100 };

  const plain = faceGeometryFromLandmarks(
    landmarks,
    coverTransform({ ...square, mirrored: false }),
  );
  expect(plain).toMatchObject({ tracked: true, box: { cx: 25, cy: 50 } });

  const mirrored = faceGeometryFromLandmarks(
    landmarks,
    coverTransform({ ...square, mirrored: true }),
  );
  expect(mirrored.box).toMatchObject({ cx: 75, cy: 50 });
});

test("fallback face is a centered untracked oval with parts inside the box", () => {
  const face = fallbackFaceGeometry(1000, 2000);
  expect(face).toMatchObject({ tracked: false, box: { cx: 500 } });
  for (const part of [face.leftEye, face.rightEye, face.lips]) {
    expect(Math.abs(part.center.x - face.box.cx)).toBeLessThan(face.box.width / 2);
    expect(Math.abs(part.center.y - face.box.cy)).toBeLessThan(face.box.height / 2);
  }
});

test("head roll survives the front-camera mirror", () => {
  // A level face: left-eye ring on the image left, right-eye ring on the
  // image right, same height. The mirror swaps the rings' sides; the roll
  // must stay ~0, not flip to ~180° (the upside-down-potato bug).
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.6 }));
  for (const i of FACE_LANDMARK_RINGS.leftEye()) landmarks[i] = { x: 0.3, y: 0.4 };
  for (const i of FACE_LANDMARK_RINGS.rightEye()) landmarks[i] = { x: 0.7, y: 0.4 };
  const square = { videoWidth: 100, videoHeight: 100, canvasWidth: 100, canvasHeight: 100 };
  for (const mirrored of [false, true]) {
    const face = faceGeometryFromLandmarks(landmarks, coverTransform({ ...square, mirrored }));
    expect(Math.abs(face.box.angle)).toBeLessThan(0.01);
  }
});

test("leftEye is the canvas-left eye even under the mirror", () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.6 }));
  for (const i of FACE_LANDMARK_RINGS.leftEye()) landmarks[i] = { x: 0.3, y: 0.4 };
  for (const i of FACE_LANDMARK_RINGS.rightEye()) landmarks[i] = { x: 0.7, y: 0.4 };
  const square = { videoWidth: 100, videoHeight: 100, canvasWidth: 100, canvasHeight: 100 };
  for (const mirrored of [false, true]) {
    const face = faceGeometryFromLandmarks(landmarks, coverTransform({ ...square, mirrored }));
    expect(face.leftEye.center.x).toBeLessThan(face.rightEye.center.x);
  }
});

test("Apple's named rings preserve screen-relative eyes and roll after front-camera mirroring", () => {
  const ring = (x: number, y: number) => [
    { x: x - 0.04, y },
    { x, y: y - 0.02 },
    { x: x + 0.04, y },
    { x, y: y + 0.02 },
  ];
  const rings = {
    box: { cx: 0.5, cy: 0.5, width: 0.6, height: 0.8 },
    eyeA: ring(0.3, 0.4),
    eyeB: ring(0.7, 0.5),
    nose: ring(0.5, 0.55),
    lips: ring(0.5, 0.7),
  };
  const face = faceGeometryFromFeatureRings(rings, 100, 200);
  expect(face).toMatchObject({
    tracked: true,
    leftEye: { center: { x: 30, y: 80 } },
    rightEye: { center: { x: 70, y: 100 } },
    box: { cx: 50, cy: 100, width: 60, height: 160 },
  });
  expect(face.box.angle).toBeCloseTo(Math.atan2(20, 40));
  const mirror = (points: { x: number; y: number }[]) =>
    points.map(({ x, y }) => ({ x: 1 - x, y }));
  const flipped = faceGeometryFromFeatureRings(
    {
      ...rings,
      eyeA: mirror(rings.eyeA),
      eyeB: mirror(rings.eyeB),
      nose: mirror(rings.nose),
      lips: mirror(rings.lips),
    },
    100,
    200,
  );
  expect(flipped.leftEye.center.x).toBeCloseTo(30);
  expect(flipped.rightEye.center.x).toBeCloseTo(70);
  expect(flipped.box.angle).toBeCloseTo(-Math.atan2(20, 40));
});
