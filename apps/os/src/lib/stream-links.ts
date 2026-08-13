import { z } from "zod";

// Canonical stream path (leading slash, lowercase path segments), formerly
// the shared streams package's StreamPath. This module owns stream-path URL
// plumbing, so the schema lives here; other UI modules import it from here.
//
const CanonicalStreamPath = z
  .string()
  .max(1023)
  .regex(/^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/);

export const StreamPath = z.preprocess<string, typeof CanonicalStreamPath, string>((value) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("/") ? decoded : `/${decoded}`;
  } catch {
    return value;
  }
}, CanonicalStreamPath);
export type StreamPath = z.infer<typeof StreamPath>;

const ROOT_SPLAT = "%2F";

export function streamPathToSplat(path: StreamPath) {
  if (path === "/") return ROOT_SPLAT;
  return path.slice(1);
}

function streamPathCandidateFromSplat(value: string | undefined) {
  if (!value || value === "" || value === ROOT_SPLAT) return "/";
  const normalized = value.replace(/^\/+/, "");
  return normalized ? `/${normalized}` : "/";
}

export function streamPathFromSplat(value: string | undefined) {
  return StreamPath.parse(streamPathCandidateFromSplat(value));
}

/** Keep parent layouts usable while a malformed child splat renders its route error boundary. */
export function streamPathFromSplatOrRoot(value: string | undefined) {
  const parsed = StreamPath.safeParse(streamPathCandidateFromSplat(value));
  return parsed.success ? parsed.data : StreamPath.parse("/");
}

export function streamPathParent(path: StreamPath) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return StreamPath.parse("/");
  return StreamPath.parse(`/${segments.slice(0, -1).join("/")}`);
}

export function streamPathAncestors(path: StreamPath) {
  if (path === "/") return ["/" as StreamPath];

  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => StreamPath.parse(`/${segments.slice(0, index + 1).join("/")}`));
}
