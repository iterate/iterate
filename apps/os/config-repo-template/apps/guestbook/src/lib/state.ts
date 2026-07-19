import type { LiveStateRpc } from "iterate/live-state";
import type { GuestbookFoldState } from "../guestbook.ts";

// The browser mirrors the processor's fold VERBATIM — the live state IS the
// domain state, no projection layer in between.
export type { GuestbookFoldState };

/** The Cap'n Web root at /api — public, so no authenticate step. */
export type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookFoldState>;
  sign(name: string, message: string): Promise<void>;
};
