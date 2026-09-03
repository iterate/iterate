import { expect, test } from "vitest";
import { buildFrameArgs, evaluateDynamicFilter } from "./definitions.ts";
import { fallbackFaceGeometry } from "./face-geometry.ts";

test("a project filter file evaluates and draws through the helpers kit", () => {
  // The documented contract: one object expression, exactly what an agent
  // would write to filters/carrot-meadow.filter.js.
  const source = `({
    label: "Carrot",
    emoji: "🥕",
    modes: ["Meadow", "Space"],
    draw(args) {
      args.ctx.fillStyle = args.modeIndex % 2 === 0 ? "#7cb342" : "#1a1a2e";
      args.ctx.fillRect(0, 0, args.width, args.height);
      args.helpers.emoji("🥕", args.face.box.cx, args.face.box.cy, args.face.box.width * 2, args.face.box.angle);
    },
  })`;
  const definition = evaluateDynamicFilter(source);
  expect(definition).toMatchObject({ label: "Carrot", emoji: "🥕", modes: ["Meadow", "Space"] });

  const recorded: string[] = [];
  // A tolerant 2D-context stand-in: records method calls, accepts property
  // sets — enough to prove the draw ran against the helpers kit headlessly.
  const ctx: any = new Proxy(
    {},
    {
      get: (_, prop) => {
        recorded.push(String(prop));
        return () => undefined;
      },
      set: () => true,
    },
  );
  const args = buildFrameArgs({
    ctx,
    frame: {} as CanvasImageSource,
    width: 400,
    height: 800,
    face: fallbackFaceGeometry(400, 800),
    backgroundIndex: 0,
    modeIndex: 1,
    modeIndex2: 0,
    action: null,
    facePose: { dx: 0, dy: 0, scale: 1 },
    maskStretch: { eyes: { x: 1, y: 1 }, nose: { x: 1, y: 1 }, lips: { x: 1, y: 1 } },
    featureHits: [],
    pitchHz: null,
    tap: null,
    drag: null,
    adjust: { featureScale: 1, faceScale: 1 },
    timeMs: 0,
  });
  definition.draw(args);
  expect(recorded).toContain("fillRect");
  expect(recorded).toContain("fillText");
});

test("a formatter-added trailing semicolon does not break evaluation", () => {
  const definition = evaluateDynamicFilter(`({ label: "X", emoji: "🧪", draw() {} });\n`);
  expect(definition.label).toBe("X");
});

test("a malformed filter file throws a useful error instead of half-working", () => {
  expect(() => evaluateDynamicFilter(`({ label: "No draw" })`)).toThrow(/draw\(args\)/);
});
