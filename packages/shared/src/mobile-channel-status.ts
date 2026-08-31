import { z } from "zod";

/**
 * The per-channel "expected native build" snapshot CI pushes to prd OS at
 * mobile publish time. One writer set (scripts/ci/mobile-preview.ts:
 * publishers, the main-build refresher, PR-close cleanup) and two readers
 * (the /m/install/<channel> interstitial and the app's
 * /m/channel-status/<channel> staleness check). Stored in the OS worker's
 * FILES_BUCKET under `platform/mobile-channel-status/<channel>.json` — the
 * deployment deliberately has no EXPO_TOKEN (apps/mobile/README.md), so this
 * snapshot is how the worker knows anything about EAS state.
 */
export const MobileChannelStatus = z.object({
  /** EAS Update channel name (scripts/ci channelForBranch alphabet). */
  channel: z.string().regex(/^[a-z0-9._-]{1,100}$/),
  /** The runtime fingerprint of the channel's latest published JS. */
  runtimeVersion: z.string().min(1),
  /** The EAS build that runs that JS. */
  buildId: z.string().min(1),
  /** The build's expo.dev page — the actual installer. */
  installUrl: z.url(),
  /** False while the build was still queued/compiling at write time. A PR
   * build that finishes later stays false until the next push (nothing polls
   * PR builds); the installUrl page is the live truth either way. */
  buildFinished: z.boolean(),
  /** Head commit of the published JS, for display. */
  commit: z.string(),
  /** Commit message / publish message, for display. */
  message: z.string(),
  /** ISO timestamp of the publish that wrote this snapshot. */
  publishedAt: z.string(),
});

export type MobileChannelStatus = z.infer<typeof MobileChannelStatus>;
