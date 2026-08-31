import { expect, test } from "vitest";
import {
  coverTransform,
  faceGeometryFromLandmarks,
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
    expect(Math.abs(part.cx - face.box.cx)).toBeLessThan(face.box.width / 2);
    expect(Math.abs(part.cy - face.box.cy)).toBeLessThan(face.box.height / 2);
  }
});
