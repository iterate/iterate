import type { StreamPath } from "@iterate-com/shared/streams/types";

export function buildProjectStreamViewerUrl(input: {
  baseUrl: string | undefined;
  organizationSlug: string;
  projectSlug: string;
  streamPath: StreamPath | string;
}) {
  const url = new URL(input.baseUrl ?? "https://os.iterate.com");
  url.pathname = projectStreamViewerPathname({
    organizationSlug: input.organizationSlug,
    projectSlug: input.projectSlug,
    streamPath: input.streamPath,
  });
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function projectStreamViewerPathname(input: {
  organizationSlug: string;
  projectSlug: string;
  streamPath: StreamPath | string;
}) {
  const streamSplat = streamPathSplat(input.streamPath);
  const basePath = ["orgs", input.organizationSlug, "projects", input.projectSlug, "streams"]
    .map(encodeURIComponent)
    .join("/");

  return streamSplat ? `/${basePath}/${streamSplat}` : `/${basePath}/`;
}

function streamPathSplat(streamPath: StreamPath | string) {
  if (streamPath === "/") return "";
  return streamPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}
