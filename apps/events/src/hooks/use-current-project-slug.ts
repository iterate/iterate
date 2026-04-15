import { useLocation } from "@tanstack/react-router";
import { resolveLocationUrl } from "~/lib/current-url.ts";
import { resolveProjectSlug } from "~/lib/project-slug.ts";

export function useCurrentProjectSlug() {
  const locationHref = useLocation({
    select: (location) => location.href,
  });
  const url = resolveLocationUrl(locationHref);
  return resolveProjectSlug({ url });
}
