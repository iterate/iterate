import type { StreamPath } from "@iterate-com/events-contract";

export function getRelativeDescendantStreamPath(
  currentPath: StreamPath,
  descendantPath: StreamPath,
): string {
  if (currentPath === "/") {
    return descendantPath === "/" ? "." : `.${descendantPath}`;
  }

  const currentPrefix = `${currentPath}/`;
  if (!descendantPath.startsWith(currentPrefix)) {
    return descendantPath;
  }

  const relativeSuffix = descendantPath.slice(currentPrefix.length);
  return relativeSuffix.length === 0 ? "." : `./${relativeSuffix}`;
}
