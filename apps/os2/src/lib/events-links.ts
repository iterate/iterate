import type { StreamPath } from "@iterate-com/shared/streams/types";

export function eventsStreamViewerUrl(input: {
  namespace: string;
  streamPath: StreamPath;
  currentOrigin?: string;
}) {
  const origin = eventsOriginFromCurrentOrigin(input.currentOrigin);
  origin.hostname = `${input.namespace}.${origin.hostname}`;
  origin.pathname = eventsStreamPathname(input.streamPath);
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}

function eventsOriginFromCurrentOrigin(currentOrigin?: string) {
  const origin = new URL(currentOrigin ?? "https://events.iterate.com");
  const labels = origin.hostname.split(".");

  if (
    labels.length === 3 &&
    (labels[0] === "os2" || labels[0] === "os") &&
    labels[1]?.startsWith("iterate-preview-") &&
    labels[2] === "com"
  ) {
    origin.hostname = `events.${labels[1]}.com`;
    return origin;
  }

  if (
    labels.length === 3 &&
    (labels[0] === "os2" || labels[0] === "os") &&
    labels[1] === "iterate" &&
    labels[2] === "com"
  ) {
    origin.hostname = "events.iterate.com";
    return origin;
  }

  origin.hostname = "events.iterate.com";
  return origin;
}

function eventsStreamPathname(streamPath: StreamPath) {
  if (streamPath === "/") return "/streams/";

  const segments = streamPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/streams/${segments.join("/")}`;
}
