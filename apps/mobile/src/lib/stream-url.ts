export function buildStreamViewerUrl(input: {
  baseUrl: string;
  projectSlug: string;
  streamPath: string;
}): string {
  const url = new URL(input.baseUrl);
  let streamSplat = "%2F";
  if (input.streamPath !== "/") {
    streamSplat = input.streamPath
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }
  url.pathname = `/projects/${encodeURIComponent(input.projectSlug)}/streams/${streamSplat}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
