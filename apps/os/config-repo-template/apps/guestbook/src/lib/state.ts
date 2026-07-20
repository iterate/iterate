import type { LiveStateRpc } from "iterate/live-state";
import type { GuestbookState } from "../guestbook.ts";

// The browser mirrors the processor's reduced state VERBATIM — the live
// state IS the domain state, no projection layer in between.
export type { GuestbookState };

/** The Cap'n Web root at /api — public, so no authenticate step. */
export type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};
