import { useLocation } from "@tanstack/react-router";
import { resolveProjectSlug } from "~/lib/project-slug.ts";

export function useCurrentProjectSlug() {
  const location = useLocation();
  return resolveProjectSlug({ url: location.href });
}
