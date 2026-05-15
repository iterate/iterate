import { StreamPath } from "@iterate-com/shared/streams/types";

const ROOT_SPLAT = "%2F";

export function streamPathToSplat(path: StreamPath) {
  if (path === "/") return ROOT_SPLAT;
  return path.slice(1);
}

export function streamPathFromSplat(value: string | undefined) {
  if (value == null || value === "" || value === ROOT_SPLAT) return StreamPath.parse("/");
  const normalized = value.replace(/^\/+/, "");
  return StreamPath.parse(normalized ? `/${normalized}` : "/");
}

export function streamPathFromInput(value: string) {
  const normalized = value.trim().replace(/^\/+/, "");
  return StreamPath.parse(normalized ? `/${normalized}` : "/");
}

export function streamPathChild(input: { parent: StreamPath; childSegment: string }) {
  const segment = normalizeStreamSegment(input.childSegment);
  const parent = input.parent === "/" ? "" : input.parent;
  return StreamPath.parse(`${parent}/${segment}`);
}

export function streamPathAncestors(path: StreamPath) {
  if (path === "/") return ["/" as StreamPath];

  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => StreamPath.parse(`/${segments.slice(0, index + 1).join("/")}`));
}

function normalizeStreamSegment(value: string) {
  const segment = value.trim().replace(/^\/+|\/+$/g, "");
  if (!segment || segment.includes("/")) {
    throw new Error("Child stream name must be one path segment.");
  }

  return segment;
}
