import { z } from "zod";

// Canonical stream path (leading slash, lowercase path segments), formerly
// the shared streams package's StreamPath. This module owns stream-path URL
// plumbing, so the schema lives here; other UI modules import it from here.
//
// Segment alphabet is `[a-z0-9_-~]`: the tilde is required for GitHub agent
// paths (`/agents/repos/g~<sha256hex>/pull-requests/<n>`). Without `~`, the
// project shell's agent roster (which runs StreamPath.parse on every status
// row) throws and the entire /projects/<slug> page hard-errors.
const CanonicalStreamPath = z
  .string()
  .max(1023)
  .regex(/^\/(?:[a-z0-9_~-]+(?:\/[a-z0-9_~-]+)*)?$/);

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

export function streamPathFromSplat(value: string | undefined) {
  if (value == null || value === "" || value === ROOT_SPLAT) return StreamPath.parse("/");
  const normalized = value.replace(/^\/+/, "");
  return StreamPath.parse(normalized ? `/${normalized}` : "/");
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
