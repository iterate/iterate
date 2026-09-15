import type { MaskStretch } from "./definitions.ts";

export type FilterAdjust = {
  mode: "hole" | "features" | "face";
  featureScale: number;
  faceScale: number;
};
export const DEFAULT_ADJUST: FilterAdjust = { mode: "hole", featureScale: 1, faceScale: 1 };
export const DEFAULT_MASK_STRETCH: MaskStretch = {
  eyes: { x: 1, y: 1 },
  nose: { x: 1, y: 1 },
  lips: { x: 1, y: 1 },
};

export function parseAdjust(value: unknown): FilterAdjust | null {
  if (typeof value !== "object" || !value) return null;
  if (
    !("mode" in value) ||
    (value.mode !== "hole" && value.mode !== "features" && value.mode !== "face")
  )
    return null;
  if (!("featureScale" in value) || !scale(value.featureScale, 0.4, 2.5)) return null;
  if (!("faceScale" in value) || !scale(value.faceScale, 0.4, 2.5)) return null;
  return { mode: value.mode, featureScale: value.featureScale, faceScale: value.faceScale };
}

export function parseMaskStretch(value: unknown): MaskStretch | null {
  if (typeof value !== "object" || !value) return null;
  const result = { ...DEFAULT_MASK_STRETCH };
  const kinds: (keyof MaskStretch)[] = ["eyes", "nose", "lips"];
  for (const kind of kinds) {
    // An absent feature uses its default, including settings saved before
    // nose adjustment existed. A present malformed value is rejected.
    if (!(kind in value)) continue;
    const stretch: unknown = Reflect.get(value, kind);
    if (typeof stretch !== "object" || !stretch || !("x" in stretch) || !("y" in stretch))
      return null;
    if (!scale(stretch.x, 0.35, 3) || !scale(stretch.y, 0.35, 3)) return null;
    result[kind] = { x: stretch.x, y: stretch.y };
  }
  return result;
}

function scale(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
