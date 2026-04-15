import { ProjectSlug, type ProjectSlug as ProjectSlugValue } from "@iterate-com/events-contract";

export const defaultProjectSlug: ProjectSlugValue = "public";
const eventsDomainSuffix = ".events.iterate.com";

export function resolveHostProjectSlug(hostname: string | null | undefined) {
  const normalizedHostname = hostname?.trim().toLowerCase();
  if (!normalizedHostname?.endsWith(eventsDomainSuffix)) {
    return undefined;
  }

  const maybeSlug = normalizedHostname.slice(0, -eventsDomainSuffix.length);
  if (!maybeSlug || maybeSlug.includes(".")) {
    return undefined;
  }

  const parsedHostProjectSlug = ProjectSlug.safeParse(maybeSlug);
  return parsedHostProjectSlug.success ? parsedHostProjectSlug.data : undefined;
}
