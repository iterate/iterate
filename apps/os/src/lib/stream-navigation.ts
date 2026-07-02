// Stream navigation helpers backing the ⌘K stream switcher: one-shot state
// reads for lazy tree-node loading.

import type { StreamTreeSource } from "~/components/stream-tree-browser.tsx";
import {
  parseBrowserCoreStreamTreeState,
  type BrowserCoreStreamTreeState,
} from "~/domains/streams/client-libraries/browser/core-processor-state.ts";

/**
 * Everything the ⌘K stream switcher needs from its host: a live state source
 * (for lazy child loading) and a way to navigate. The switcher replaces both
 * breadcrumbs and the stream tree sidebar.
 */
export type StreamNavigator = {
  source: StreamTreeSource;
  onOpenPath: (streamPath: string) => void;
};

/**
 * Reads one stream's current state via a one-shot subscription: the first
 * push carries current state (DECISIONS D20), so subscribe → first push →
 * unsubscribe is the cheapest "fetch".
 */
export function readStreamStateOnce(
  source: StreamTreeSource,
  streamPath: string,
): Promise<BrowserCoreStreamTreeState> {
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
      .subscribe({
        events: false,
        processEventBatch: (batch) => {
          if (done) return;
          done = true;
          try {
            resolve(parseBrowserCoreStreamTreeState(batch.state));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
          finish();
        },
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

/**
 * URL sentinel for streams that live outside any project (platform streams):
 * the admin stream browser addresses them as `/admin/streams/__null__/...`.
 */
export const NULL_DURABLE_OBJECT_PROJECT_ID = "__null__";

/**
 * Human label for the `__null__` namespace wherever it would otherwise render
 * as a project id. URLs and route params keep the sentinel; only display
 * strings use this (deployment-level streams like slack-team-directory
 * legitimately live there).
 */
export function streamProjectDisplayLabel(projectId: string): string {
  return projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? "Global (deployment)" : projectId;
}
