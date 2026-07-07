/**
 * Stream capabilities expose `.at(relativePath)` to code that should stay
 * scoped beneath the stream it already holds. This helper is the shared guard
 * for that capability boundary: relative paths can descend into children or
 * walk back up within the held stream's root, while attempts to escape above it
 * fail before a new Durable Object name is minted.
 */
export function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `stream path "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
