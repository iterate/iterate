// Stream navigation helpers backing the ⌘K stream switcher: one-shot state
// reads for lazy child loading, and best-effort localStorage recents.

import {
  StreamPath,
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
  return new Promise((resolve, reject) => {
    let done = false;
    let release: (() => void) | null = null;
    const finish = () => release?.();
    source(streamPath)
      .onStateChange((state) => {
        if (done) return;
        done = true;
        resolve(StreamState.parse(state));
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
      });
  });
}

export function parentStreamPath(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent === "" ? "/" : parent;
}

export function parseStreamPath(path: string): StreamPathType {
  return StreamPath.parse(path);
}

// ---------------------------------------------------------------------------
// Recents (localStorage)
// ---------------------------------------------------------------------------

const MAX_RECENT_STREAMS = 8;

function recentStreamsStorageKey(scope: string) {
  return `iterate:recent-streams:${scope}`;
}

export function recordRecentStream(scope: string, streamPath: string) {
  try {
    const existing = readRecentStreams(scope).filter((path) => path !== streamPath);
    window.localStorage.setItem(
      recentStreamsStorageKey(scope),
      JSON.stringify([streamPath, ...existing].slice(0, MAX_RECENT_STREAMS)),
    );
  } catch {
    // Storage may be unavailable (private mode); recents are best-effort.
  }
}

export function readRecentStreams(scope: string): string[] {
  try {
    const raw = window.localStorage.getItem(recentStreamsStorageKey(scope));
    const parsed: unknown = raw == null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}
