import {
  buildFrameArgs,
  evaluateDynamicFilter,
  FILTER_DRAWERS,
  FILTER_MODES,
  FILTER_MODES_2,
  FILTER_ACTIONS,
  type DynamicFilterDefinition,
  type FeatureHit,
  type FilterFrameArgs,
} from "./definitions.ts";
import { fallbackFaceGeometry, faceGeometryFromFeatureRings } from "./face-geometry.ts";
import { nativeContext } from "./native-graphics.ts";

export type NativeFilterSettings = {
  filterId: string;
  dynamicFilters: { id: string; source: string }[];
  backgroundIndex: number;
  modeIndex: number;
  modeIndex2: number;
  action: FilterFrameArgs["action"];
  tap: FilterFrameArgs["tap"];
  drag: FilterFrameArgs["drag"];
  adjust: FilterFrameArgs["adjust"];
  maskStretch: FilterFrameArgs["maskStretch"];
};

const dynamic = new Map<string, { source: string; definition: DynamicFilterDefinition }>();
let settings: NativeFilterSettings;
let baseline: { cx: number; cy: number; width: number } | null = null;

export function configure(next: NativeFilterSettings) {
  if (!settings || settings.filterId !== next.filterId) baseline = null;
  for (const [id, cached] of dynamic) {
    if (!next.dynamicFilters.some((filter) => filter.id === id && filter.source === cached.source))
      dynamic.delete(id);
  }
  settings = next;
  const selected = settings.dynamicFilters.find((filter) => filter.id === settings.filterId);
  if (selected && !dynamic.has(selected.id))
    dynamic.set(selected.id, {
      source: selected.source,
      definition: evaluateDynamicFilter(selected.source),
    });
  const definition = dynamic.get(settings.filterId)?.definition;
  if (!definition && !FILTER_DRAWERS[settings.filterId])
    throw new Error(`Unknown filter: ${settings.filterId}`);
  return {
    modes: definition?.modes || FILTER_MODES[settings.filterId] || [],
    modes2: FILTER_MODES_2[settings.filterId] || [],
    actions: definition?.actions || FILTER_ACTIONS[settings.filterId] || [],
  };
}

export function frame(input: {
  width: number;
  height: number;
  timeMs: number;
  pitchHz: number | null;
  face: Parameters<typeof faceGeometryFromFeatureRings>[0] | null;
}): { featureHits: FeatureHit[]; tracked: boolean } {
  const face = input.face
    ? faceGeometryFromFeatureRings(input.face, input.width, input.height)
    : fallbackFaceGeometry(input.width, input.height);
  if (face.tracked && !baseline) baseline = face.box;
  const args = buildFrameArgs({
    ...settings,
    ...input,
    face,
    ctx: nativeContext(1),
    frame: { source: 0, width: input.width, height: input.height },
    facePose:
      baseline && face.tracked
        ? {
            dx: face.box.cx - baseline.cx,
            dy: face.box.cy - baseline.cy,
            scale: face.box.width / baseline.width,
          }
        : { dx: 0, dy: 0, scale: 1 },
    featureHits: [],
  });
  args.ctx.drawImage(args.frame, 0, 0);
  const definition = dynamic.get(settings.filterId)?.definition;
  if (definition) definition.draw(args);
  else FILTER_DRAWERS[settings.filterId](args);
  return { featureHits: args.featureHits, tracked: face.tracked };
}
