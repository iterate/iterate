import { useLocation } from "@tanstack/react-router";
import { normalizeProjectSlug, projectSlugSearchParam } from "~/lib/project-slug.ts";

export function useCurrentProjectSlug() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.searchStr);

  return normalizeProjectSlug(searchParams.get(projectSlugSearchParam));
}
