// Stream navigation helpers backing the ⌘K stream switcher: one-shot state
// reads for lazy tree-node loading.

import {
  StreamState,
  type StreamPath as StreamPathType,
  type StreamState as StreamStateType,
} from "@iterate-com/shared/streams/types";
import type { StreamTreeSource } from "~/components/stream-tree-browser.tsx";

/**
 * Everything the ⌘K stream switcher needs from its host: a live state source
 * (for lazy child loading) and a way to navigate. The switcher replaces both
 * breadcrumbs and the stream tree sidebar.
 */
export type StreamNavigator = {
  source: StreamTreeSource;
  onOpenPath: (streamPath: StreamPathType) => void;
};

/**
 * Reads one stream's current state via a one-shot subscription: the first
 * push carries current state (DECISIONS D20), so subscribe → first push →
 * unsubscribe is the cheapest "fetch".
 */
export function readStreamStateOnce(
  source: StreamTreeSource,
  streamPath: StreamPathType,
): Promise<StreamStateType> {
  const READ_STATE_TIMEOUT_MS = 10_000;
  return new Promise((resolve, reject) => {
    let done = false;
    let release: (() => void) | null = null;
    const finish = () => {
      clearTimeout(deadline);
      release?.();
    };
    // Subscribe can succeed without a state push ever arriving (a wedged
    // stream); bound the wait so the ⌘K child query errors instead of hanging.
    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`timed out reading state for ${streamPath}`));
      finish();
    }, READ_STATE_TIMEOUT_MS);
    source(streamPath)
      .onStateChange((state) => {
        if (done) return;
        done = true;
        try {
          resolve(StreamState.parse(state));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        finish();
      })
      .then((subscription) => {
        release = () => void Promise.resolve(subscription.unsubscribe()).catch(() => {});
        if (done) finish();
      })
      .catch((error: unknown) => {
        if (done) return;
        done = true;
        reject(error instanceof Error ? error : new Error(String(error)));
        finish();
      });
  });
}
