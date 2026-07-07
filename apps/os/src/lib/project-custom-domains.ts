import type { ProjectCustomDomain } from "~/types.ts";

export function primaryActiveCustomDomainHostname(
  domains?: readonly ProjectCustomDomain[] | null,
): string | null {
  const activeDomains = domains?.filter((domain) => domain.status === "active") ?? [];
  activeDomains.sort(comparePrimaryCustomDomain);
  return activeDomains.at(0)?.hostname ?? null;
}

function comparePrimaryCustomDomain(a: ProjectCustomDomain, b: ProjectCustomDomain) {
  return (
    hostnameLabelCount(a.hostname) - hostnameLabelCount(b.hostname) ||
    a.hostname.length - b.hostname.length ||
    a.hostname.localeCompare(b.hostname)
  );
}

function hostnameLabelCount(hostname: string) {
  return hostname.split(".").length;
}
