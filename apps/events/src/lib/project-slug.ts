import { ProjectSlug, type ProjectSlug as ProjectSlugValue } from "@iterate-com/events-contract";

export const defaultProjectSlug: ProjectSlugValue = "public";
const publicEventsHost = "events.iterate.com";
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

export function getProjectUrl(args: { currentUrl: string | URL; projectSlug: ProjectSlugValue }) {
  const url = new URL(args.currentUrl);

  if (url.hostname === publicEventsHost || url.hostname.endsWith(`.${publicEventsHost}`)) {
    url.hostname =
      args.projectSlug === defaultProjectSlug
        ? publicEventsHost
        : `${args.projectSlug}.${publicEventsHost}`;
  }

  return url;
}
