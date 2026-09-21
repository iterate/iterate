import { z } from "zod";

/** Parked Workers need time to stop serving the previous Durable Object version. */
export const previewSlotRestMs = 150_000;
export const PreviewSlotPreparation = z.object({
  "preview-policy": z.literal("parked-v1"),
  "preview-parked-at": z.coerce.number().int().positive(),
  "preview-ready-at": z.coerce.number().int().positive(),
});

/** Missing or uncertain preparation always selects erase plus the normal rollout guard. */
export function preparedPreviewSlot(tags: Record<string, unknown> | undefined, now: number) {
  const result = PreviewSlotPreparation.safeParse(tags);
  if (!result.success) return null;
  const preparation = result.data;
  if (
    preparation["preview-ready-at"] > now ||
    preparation["preview-ready-at"] - preparation["preview-parked-at"] < previewSlotRestMs
  )
    return null;
  return preparation;
}
