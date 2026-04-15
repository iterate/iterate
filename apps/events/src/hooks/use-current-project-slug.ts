import { getGlobalStartContext } from "@tanstack/react-start";
import { useLocation } from "@tanstack/react-router";
import { resolveProjectSlug } from "~/lib/project-slug.ts";

export function useCurrentProjectSlug() {
  const locationHref = useLocation({
    select: (location) => location.href,
  });
  const url = new URL(
    locationHref,
    typeof window !== "undefined"
      ? window.location.origin
      : (getGlobalStartContext()?.rawRequest?.url ?? "http://localhost/"),
  );

  return resolveProjectSlug({ url });
}
