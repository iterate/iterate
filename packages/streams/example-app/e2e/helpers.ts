import { normalizeStreamPath, streamRpcPath } from "../../src/browser/connect.ts";
import { streamViewSearch } from "../src/lib/stream-view-search.ts";

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

export function toStreamWebSocketUrl(args: { path: string; namespace?: string }) {
  const path = e2eStreamPath(args.path);
  const url = new URL(streamRpcPath({ path, namespace: args.namespace }), e2eWorkerUrl());
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export function streamProcessorRunnerName(args: {
  namespace: string;
  path: string;
  subscriptionKey: string;
}) {
  return `${args.namespace}:${e2eStreamPath(args.path)}:${args.subscriptionKey}`;
}

export function toStreamProcessorRunnerWebSocketUrl(
  runnerName: string,
  params: { processorSlug?: string } = {},
) {
  const url = new URL(e2eWorkerUrl());
  url.pathname = `/stream-processor-runner/${runnerName}`;
  if (params.processorSlug !== undefined) {
    url.searchParams.set("processorSlug", params.processorSlug);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export function streamRoute(args: { path: string; namespace?: string; view?: string }) {
  const search = streamViewSearch({
    path: e2eStreamPath(args.path),
    namespace: args.namespace,
    view: args.view,
  });
  const params = new URLSearchParams({
    path: search.path,
    namespace: search.namespace,
    view: search.view,
  });
  return `/streams?${params.toString()}`;
}
