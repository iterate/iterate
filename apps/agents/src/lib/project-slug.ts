import { type ProjectSlug as ProjectSlugValue } from "@iterate-com/events-contract";

// Local copy of the subset of `apps/events/src/lib/project-slug.ts` we need in the
// agents worker. Kept small: only `getProjectUrl` is used (by `iterate-agent.ts` to
// derive the per-project Events origin). If Events's slug/host logic changes, update
// this mirror in lockstep (or promote the shared pieces into `@iterate-com/events-contract`).

const defaultProjectSlug: ProjectSlugValue = "public";
const iterateDomainLabels = ["iterate", "com"] as const;
const eventsHostLabelPattern = /^events(?:-[a-z0-9-]+)*$/;

function getEventsHostBase(hostname: string) {
  const labels = hostname.split(".");

  if (
    labels.length === 3 &&
    labels[1] === iterateDomainLabels[0] &&
    labels[2] === iterateDomainLabels[1] &&
    eventsHostLabelPattern.test(labels[0])
  ) {
    return hostname;
  }

  if (
    labels.length === 4 &&
    labels[2] === iterateDomainLabels[0] &&
    labels[3] === iterateDomainLabels[1] &&
    eventsHostLabelPattern.test(labels[1])
  ) {
    return labels.slice(1).join(".");
  }

  return undefined;
}

export function getProjectUrl(args: { currentUrl: string | URL; projectSlug: ProjectSlugValue }) {
  const url = new URL(args.currentUrl);
  const eventsHostBase = getEventsHostBase(url.hostname);

  if (eventsHostBase) {
    url.hostname =
      args.projectSlug === defaultProjectSlug
        ? eventsHostBase
        : `${args.projectSlug}.${eventsHostBase}`;
  }

  return url;
}
