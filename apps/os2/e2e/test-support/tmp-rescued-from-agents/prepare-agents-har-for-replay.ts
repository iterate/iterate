import type { HarWithExtensions } from "@iterate-com/mock-http-proxy";

/**
 * Recorded HARs pin absolute URLs (including `vitest-run-…` project hostname). MSW `fromTraffic`
 * matches those literals, so replay would miss when the slug changes. Rewrite any Iterate Events
 * project hostname in the archive to `targetEventsHostname` so handlers match this run.
 */
export function prepareAgentsHarForReplay(
  archive: HarWithExtensions,
  targetEventsHostname: string,
): HarWithExtensions {
  const clone = JSON.parse(JSON.stringify(archive)) as HarWithExtensions;

  for (const entry of clone.log.entries) {
    entry.request.url = rewriteUrlIfEventsProjectHost(entry.request.url, targetEventsHostname);
    entry.response.headers = entry.response.headers.filter(
      (header) => header.name.toLowerCase() !== "content-length",
    );
  }

  return clone;
}

function rewriteUrlIfEventsProjectHost(urlString: string, targetEventsHostname: string): string {
  try {
    const u = new URL(urlString);
    if (shouldRewriteEventsProjectHostname(u.hostname)) {
      u.hostname = targetEventsHostname;
      return u.toString();
    }
  } catch {
    /* ignore malformed */
  }
  return urlString;
}

function shouldRewriteEventsProjectHostname(hostname: string): boolean {
  if (hostname.endsWith(".events.iterate-preview-1.com")) {
    return true;
  }
  const labels = hostname.split(".");
  return (
    labels.length >= 4 &&
    hostname.endsWith(".events.iterate.com") &&
    hostname !== "www.events.iterate.com"
  );
}
