import { linkOptions } from "@tanstack/react-router";
import { z } from "zod";

// Canonical stream path (leading slash, lowercase kebab segments), formerly
// the shared streams package's StreamPath. This module owns stream-path URL
// plumbing, so the schema lives here; other UI modules import it from here.
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

export function streamPathFromSplat(value: string | undefined) {
  if (value == null || value === "" || value === ROOT_SPLAT) return StreamPath.parse("/");
  const normalized = value.replace(/^\/+/, "");
  return StreamPath.parse(normalized ? `/${normalized}` : "/");
}

export function streamPathChild(input: { parent: StreamPath; childSegment: string }) {
  const segment = normalizeStreamSegment(input.childSegment);
  const parent = input.parent === "/" ? "" : input.parent;
  return StreamPath.parse(`${parent}/${segment}`);
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

/**
 * The canonical page for a stream path. Every domain object IS a stream, and
 * each domain page is that stream's view (stream main, reduced-state panel at
 * the side) — so stream navigation (⌘K switcher, path breadcrumbs) lands on
 * the domain page when one owns the path, and on the generic stream page
 * otherwise. Fresh `search` everywhere: a new stream opens with its own
 * default tab and filters rather than inheriting the previous view's.
 */
export function linkOptionsForStreamPath(projectSlug: string, streamPath: StreamPath) {
  const segments = streamPath.split("/").filter(Boolean);
  const params = { projectSlug };

  if (streamPath === "/") {
    return linkOptions({ to: "/projects/$projectSlug", params, search: {} });
  }
  if (streamPath === "/secrets") {
    return linkOptions({ to: "/projects/$projectSlug/secrets", params, search: {} });
  }
  if (segments[0] === "secrets" && segments.length === 2) {
    return linkOptions({
      to: "/projects/$projectSlug/secrets/$secretId",
      params: { ...params, secretId: segments[1]! },
      search: {},
    });
  }
  if (streamPath === "/repos") {
    return linkOptions({ to: "/projects/$projectSlug/repos", params, search: {} });
  }
  if (segments[0] === "repos") {
    return linkOptions({
      to: "/projects/$projectSlug/repos/$",
      params: { ...params, _splat: segments.slice(1).join("/") },
      search: {},
    });
  }
  if (streamPath === "/integrations") {
    return linkOptions({ to: "/projects/$projectSlug/integrations", params, search: {} });
  }
  if (streamPath === "/agents") {
    return linkOptions({ to: "/projects/$projectSlug/agents", params, search: {} });
  }
  if (segments[0] === "agents") {
    return linkOptions({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { ...params, _splat: streamPath },
      search: {},
    });
  }
  return linkOptions({
    to: "/projects/$projectSlug/streams/$",
    params: { ...params, _splat: streamPath },
    search: {},
  });
}

function normalizeStreamSegment(value: string) {
  const segment = value.trim().replace(/^\/+|\/+$/g, "");
  if (!segment || segment.includes("/")) {
    throw new Error("Child stream name must be one path segment.");
  }

  return segment;
}
