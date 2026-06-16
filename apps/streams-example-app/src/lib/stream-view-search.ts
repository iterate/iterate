import { STREAM_VIEWS } from "../routes/-stream-views.ts";
import { DEFAULT_STREAM_PROJECT_ID, normalizeStreamPath } from "./stream-rpc.ts";

export type StreamViewSearch = {
  path: string;
  projectId: string;
  view: string;
};

export function parseStreamViewSearch(args: { search: Record<string, unknown> }): StreamViewSearch {
  const path = normalizeStreamPath({
    path: typeof args.search.path === "string" ? args.search.path : undefined,
  });
  const projectIdRaw =
    typeof args.search.projectId === "string" ? args.search.projectId.trim() : "";
  const projectId = projectIdRaw === "" ? DEFAULT_STREAM_PROJECT_ID : projectIdRaw;
  const view =
    typeof args.search.view === "string" &&
    STREAM_VIEWS.some((entry) => entry.slug === args.search.view)
      ? args.search.view
      : "browser-raw-events";
  return { path, projectId, view };
}

export function streamViewSearch(args: {
  path: string;
  projectId?: string;
  view?: string;
}): StreamViewSearch {
  const path = normalizeStreamPath({ path: args.path });
  const projectIdRaw = args.projectId?.trim();
  const projectId =
    projectIdRaw === undefined || projectIdRaw === "" ? DEFAULT_STREAM_PROJECT_ID : projectIdRaw;
  const view = args.view ?? "browser-raw-events";
  return { path, projectId, view };
}
