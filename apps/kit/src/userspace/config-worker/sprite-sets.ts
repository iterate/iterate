/**
 * Stable public slugs for the sprite atlases compiled into display devices.
 *
 * This contract lives inside the config-worker deployment boundary because the
 * userspace installer deliberately ships one closed `apps/kit-voice/**` module
 * graph. Importing a convenient source-tree sibling worked in local Vitest but
 * produced a cold-start `No such module` in the real userspace builder. Device
 * API types re-export this module, so there remains one TypeScript authority;
 * the generated C registry is checked separately by firmware tests.
 *
 * RPCs carry a slug rather than an array index because build-time atlas order
 * is not public. The closed set also prevents a model-generated tool argument
 * from becoming a filename or arbitrary asset lookup.
 */
export const KIT_SPRITE_SETS = ["dot-matrix-oracle", "karakuri-brass", "starbyte"] as const;

export type KitSpriteSet = (typeof KIT_SPRITE_SETS)[number];

export function isKitSpriteSet(value: unknown): value is KitSpriteSet {
  return typeof value === "string" && KIT_SPRITE_SETS.some((candidate) => candidate === value);
}
