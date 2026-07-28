// Stream navigation helpers for the platform-wide admin stream explorer.

import { useMemo } from "react";
import type { StreamConnectionHandle } from "iterate/processors";
import { connectItx, connectIterateSession, reportTransportSuspicion } from "iterate/sdk/itx/react";
import {
  parseBrowserCoreStreamTreeState,
  type BrowserCoreStreamTreeState,
} from "~/domains/streams/client-libraries/browser/core-processor-state.ts";

/**
 * Where remote admin tree nodes get state: path → stream callback connection.
 */
export type StreamTreeSource = (streamPath: string) => {
  openConnection(args: {
    events?: boolean;
    processEventBatch(batch: { state: unknown }): unknown;
  }): Promise<StreamConnectionHandle>;
};

/**
 * Navigation plus the optional lazy source required only by the admin explorer.
 * Project navigation reads the single materialized live-state index instead.
 */
export type StreamNavigator = {
  remoteTreeSource?: StreamTreeSource;
  onOpenPath: (streamPath: string) => void;
};

/**
 * Reads one remote admin stream's state via a short-lived callback connection:
 * the first push carries current state (DECISIONS D20), so open → first push
 * → close is the cheapest "fetch".
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
      .openConnection({
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
      .then((connection) => {
        release = () =>
          void Promise.resolve(connection.close())
            .catch(() => {})
            // Release the stub too: on the tab-long shared socket, an
            // undisposed handle leaks one import-table entry per ⌘K node read.
            .finally(() => (connection as Partial<Disposable>)[Symbol.dispose]?.());
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

/**
 * The admin pages' stream source: they address arbitrary projects through the
 * global (admin) session — the deployment-wide stream catalog for the null
 * project, otherwise the project's own itx via projects.get(id). Returns the
 * resolved project id (null for the deployment namespace) alongside. The
 * source's inferred type is the full itx stream handle, so it satisfies both
 * the tree browser's and the stream view's source contracts.
 */
export function useAdminStreamSource(projectId: string) {
  const streamProjectId = projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : projectId;
  // Resolve the CURRENT session per call rather than capturing a render-time
  // handle: the stream runtimes hold this source across socket deaths, and a
  // captured stub would pin the dead transport forever (the suspend/resume feed
  // wedge — see project-stream-view.tsx's source for the full story). Admin
  // reads the deployment-wide catalog off the session directly; a specific
  // project via session.projects.get(id).
  const source = useMemo(
    () => async (streamPath: string) =>
      streamProjectId == null
        ? (await connectIterateSession()).streams.get(streamPath)
        : (await connectItx(streamProjectId)).streams.get(streamPath),
    [streamProjectId],
  );
  return { source, streamProjectId, resetTransport: reportTransportSuspicion };
}
