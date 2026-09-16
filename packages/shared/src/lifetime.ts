import { z } from "zod";

/** A limit on recurring background work. Data is retained after expiry.
 * A group can retire its members early; omitting it gives a fixed deadline only.
 */
export const Lifetime = z.object({
  expiresAt: z.number().int().positive(),
  group: z.string().min(1).max(200).optional(),
});
export type Lifetime = z.infer<typeof Lifetime>;

export const ProjectMetadata = z.looseObject({ lifetime: Lifetime.optional() });

/** Lifetimes are creation metadata: changing them could revive retired objects. */
export function haveSameLifetime(previous: unknown, next: unknown): boolean {
  const a = ProjectMetadata.parse(previous).lifetime;
  const b = ProjectMetadata.parse(next).lifetime;
  return a?.expiresAt === b?.expiresAt && a?.group === b?.group;
}
