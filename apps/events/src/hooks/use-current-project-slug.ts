import { useLocation } from "@tanstack/react-router";
import { resolveProjectSlug } from "~/lib/project-slug.ts";

export function useCurrentProjectSlug() {
  const location = useLocation();
  const url = new URL(location.href, window.location.origin);
  return resolveProjectSlug({ url });
}
