import type { LiveStateRpc } from "iterate/live-state";

/** One signature, exactly as the processor's fold carries it. */
export type GuestbookEntry = { name: string; message: string; signedAt: string };

/** The live-state value every connected browser mirrors: the guestbook fold
 * projected for display (title unwrapped from the birth certificate). */
export type GuestbookState = {
  title: string;
  entries: GuestbookEntry[];
  lastMilestone: number;
};

/** The Cap'n Web root at /api — public, so no authenticate step. */
export type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};
