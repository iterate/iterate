/*
 * Device-facing code keeps this stable import path, while the implementation
 * belongs to the closed userspace deployment graph. Re-exporting avoids a
 * second slug list whose drift would make local types disagree with Grok's
 * production tool schema.
 */
export {
  isKitSpriteSet,
  KIT_SPRITE_SETS,
  type KitSpriteSet,
} from "../userspace/config-worker/sprite-sets.ts";
