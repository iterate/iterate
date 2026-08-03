// Stream navigation helpers for the platform-wide admin stream explorer.

import { useMemo } from "react";
import { connectItx, connectIterateSession, reportTransportSuspicion } from "iterate/sdk/itx/react";

/** Open a stream path from a project or admin navigation surface. */
export type StreamNavigator = {
  onOpenPath: (streamPath: string) => void;
};

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
