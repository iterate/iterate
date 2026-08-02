/** The project slug, read off the `tasks--<slug>` app host. */
export function projectSlug(): string {
  if (typeof window === "undefined") return "project";
  const match = /^tasks--([^.]+)\./.exec(window.location.hostname);
  return match?.[1] ?? window.location.hostname;
}
