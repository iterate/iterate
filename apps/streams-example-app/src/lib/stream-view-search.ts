import { STREAM_VIEWS } from "../routes/-stream-views.ts";
import {
  DEFAULT_STREAM_NAMESPACE,
  normalizeStreamPath,
} from "~/domains/streams/engine/browser/connect.ts";

export type StreamViewSearch = {
  path: string;
  namespace: string;
  view: string;
};

export function parseStreamViewSearch(args: { search: Record<string, unknown> }): StreamViewSearch {
  const path = normalizeStreamPath({
    path: typeof args.search.path === "string" ? args.search.path : undefined,
  });
  const namespaceRaw =
    typeof args.search.namespace === "string" ? args.search.namespace.trim() : "";
  const namespace = namespaceRaw === "" ? DEFAULT_STREAM_NAMESPACE : namespaceRaw;
  const view =
    typeof args.search.view === "string" &&
    STREAM_VIEWS.some((entry) => entry.slug === args.search.view)
      ? args.search.view
      : "browser-raw-events";
  return { path, namespace, view };
}

export function streamViewSearch(args: {
  path: string;
  namespace?: string;
  view?: string;
}): StreamViewSearch {
  const path = normalizeStreamPath({ path: args.path });
  const namespaceRaw = args.namespace?.trim();
  const namespace =
    namespaceRaw === undefined || namespaceRaw === "" ? DEFAULT_STREAM_NAMESPACE : namespaceRaw;
  const view = args.view ?? "browser-raw-events";
  return { path, namespace, view };
}
