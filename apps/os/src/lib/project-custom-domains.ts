import type { ProjectCustomDomain } from "~/types.ts";

export function primaryActiveCustomDomainHostname(
  domains?: readonly ProjectCustomDomain[] | null,
): string | null {
  return domains?.find((domain) => domain.status === "active")?.hostname ?? null;
}
