import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth-client.ts";
import { orpcClient } from "./query.tsx";

type Organization = Awaited<ReturnType<typeof orpcClient.user.myOrganizations>>[number];

export function oauthConsentsQueryOptions() {
  return queryOptions({
    queryKey: ["better-auth", "oauth2", "consents"] as const,
    queryFn: () => authClient.oauth2.getConsents(),
  });
}

export function oauthClientQueryOptions(clientId: string) {
  return queryOptions({
    queryKey: ["better-auth", "oauth2", "client", clientId] as const,
    queryFn: () => authClient.oauth2.publicClient({ query: { client_id: clientId } }),
  });
}

export function organizationsQueryOptions() {
  return queryOptions({
    queryKey: ["better-auth", "organizations"] as const,
    queryFn: () => orpcClient.user.myOrganizations(),
  });
}

export function projectSelectionQueryOptions(organizations: Organization[]) {
  return queryOptions({
    queryKey: [
      "better-auth",
      "oauth2",
      "project-selection",
      organizations.map((organization) => organization.slug),
    ] as const,
    queryFn: async () => projectSelectionsForOrganizations(organizations),
  });
}

async function projectSelectionsForOrganizations(organizations: Organization[]) {
  return Promise.all(
    organizations.map(async (organization) => ({
      organization,
      projects: await orpcClient.project.list({ organizationSlug: organization.slug }),
    })),
  );
}
