import type { StreamPath } from "~/lib/stream-links.ts";

export function buildProjectStreamViewerUrl(input: {
  baseUrl: string | undefined;
  projectSlug: string;
  streamPath: StreamPath | string;
}) {
  const url = new URL(input.baseUrl ?? "https://os.iterate.com");
  url.pathname = projectStreamViewerPathname({
    projectSlug: input.projectSlug,
    streamPath: input.streamPath,
  });
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function projectStreamViewerPathname(input: {
  projectSlug: string;
  streamPath: StreamPath | string;
}) {
  const streamSplat = streamPathSplat(input.streamPath);
  const basePath = ["projects", input.projectSlug, "streams"].map(encodeURIComponent).join("/");

  return `/${basePath}/${streamSplat}`;
}

function streamPathSplat(streamPath: StreamPath | string) {
  // The root stream must stay distinguishable from the streams index route
  // (`/streams/`), so it keeps an encoded slash as its splat segment.
  if (streamPath === "/") return "%2F";
  return streamPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}
