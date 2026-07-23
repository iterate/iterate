import { createContext } from "react";

/** The project slug, read off the `tasks--<slug>` app host. */
export function projectSlug(): string {
  if (typeof window === "undefined") return "project";
  const match = /^tasks--([^.]+)\./.exec(window.location.hostname);
  return match?.[1] ?? window.location.hostname;
}

/** Server-derived project label (root loader) — SSR and client agree, so the
 * breadcrumb never flashes a placeholder. */
export const ProjectLabelContext = createContext("tasks");
