import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/events-contract";

export function streamPathToSplat(path: StreamPathType): string {
  return path === "/" ? "" : path.slice(1);
}

export function streamPathFromSplat(splat: string | undefined): StreamPathType {
  return parseRoutedStreamPath(splat);
}

export function streamPathFromPathname(pathname: string): StreamPathType | null {
  if (pathname === "/streams" || pathname === "/streams/") {
    return "/";
  }

  if (!pathname.startsWith("/streams/")) {
    return null;
  }

  return streamPathFromSplat(pathname.slice("/streams/".length));
}

function parseRoutedStreamPath(value: string | undefined): StreamPathType {
  if (value == null || value.length === 0) {
    return "/";
  }

  const normalized = value.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return "/";
  }

  return StreamPath.parse(normalized);
}
