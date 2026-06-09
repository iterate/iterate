import type { StreamPath } from "@iterate-com/shared/streams/types";

const DEFAULT_STREAM_NAMESPACE = "default";
const PRODUCTION_STREAMS_EXAMPLE_APP_ORIGIN = "https://os-streams.iterate.workers.dev";
const LOCAL_STREAMS_EXAMPLE_APP_ORIGIN = "http://localhost:5173";

export function eventsStreamViewerUrl(input: {
  namespace: string;
  streamPath: StreamPath;
  currentOrigin?: string;
}) {
  const currentOrigin = input.currentOrigin ?? "https://os.iterate.com";
  if (!shouldUseStreamsExampleAppViewer(currentOrigin)) return null;
  return streamsExampleAppViewerUrl({
    baseUrl: streamsExampleAppBaseUrl(currentOrigin),
    namespace: input.namespace,
    streamPath: input.streamPath,
  });
}

export function streamsExampleAppViewerUrl(input: {
  baseUrl: string;
  namespace: string;
  streamPath: StreamPath;
  view?: string;
}) {
  const url = new URL("/streams", input.baseUrl);
  url.searchParams.set("path", normalizeStreamPath(String(input.streamPath)));
  const namespace = input.namespace.trim();
  if (namespace !== "" && namespace !== DEFAULT_STREAM_NAMESPACE) {
    url.searchParams.set("namespace", namespace);
  }
  if (input.view !== undefined && input.view !== "") {
    url.searchParams.set("view", input.view);
  }
  return url.toString();
}

function shouldUseStreamsExampleAppViewer(currentOrigin: string) {
  const { hostname } = new URL(currentOrigin);
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  return hostname === "os.iterate.com";
}

function streamsExampleAppBaseUrl(currentOrigin: string) {
  const { hostname } = new URL(currentOrigin);
  if (hostname === "localhost" || hostname === "127.0.0.1") return LOCAL_STREAMS_EXAMPLE_APP_ORIGIN;
  return PRODUCTION_STREAMS_EXAMPLE_APP_ORIGIN;
}

function normalizeStreamPath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
