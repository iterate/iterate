import { streamViewSearch } from "../src/lib/stream-view-search.ts";
import { normalizeStreamPath, streamRpcPath } from "../src/lib/stream-rpc.ts";

export function e2eWorkerUrl() {
  return process.env.WORKER_URL ?? "http://localhost:5173";
}

/** Canonical stream path for e2e — always matches Stream DO identity after normalizeStreamPath. */
export function e2eStreamPath(path: string) {
  return normalizeStreamPath({ path });
}

export function e2eStreamPathLabel(label: string) {
  return e2eStreamPath(`/${label}-${crypto.randomUUID()}`);
}

export function toStreamWebSocketUrl(args: { path: string; projectId?: string }) {
  const path = e2eStreamPath(args.path);
  const url = new URL(streamRpcPath({ path, projectId: args.projectId }), e2eWorkerUrl());
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export function streamRoute(args: { path: string; projectId?: string; view?: string }) {
  const search = streamViewSearch({
    path: e2eStreamPath(args.path),
    projectId: args.projectId,
    view: args.view,
  });
  const params = new URLSearchParams({
    path: search.path,
    projectId: search.projectId,
    view: search.view,
  });
  return `/streams?${params.toString()}`;
}
