/** The project slug, read off the `docs--<slug>` app host. */
export function projectSlug(): string {
  if (typeof window === "undefined") return "project";
  const match = /^docs--([^.]+)\./.exec(window.location.hostname);
  return match?.[1] ?? window.location.hostname;
}
