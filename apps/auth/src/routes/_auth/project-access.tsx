import { Button } from "@iterate-com/ui/components/button";
import { ITERATE_PROJECT_SELECTION_SCOPE } from "@iterate-com/shared/auth-claims";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Separator } from "@iterate-com/ui/components/separator";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Field, FieldError, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { z } from "zod/v4";
import { authClient, useSession } from "../../utils/auth-client.ts";
import { getInitials } from "../../utils/initials.ts";
import { orpcClient } from "../../utils/query.tsx";

export const Route = createFileRoute("/_auth/project-access")({
  component: RouteComponent,
  validateSearch: z.looseObject({
    client_id: z.string().optional(),
    scope: z.string().optional(),
  }),
});

const CreateOrganizationInput = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(100),
});

function RouteComponent() {
  const { client_id, scope } = Route.useSearch();
  const navigate = Route.useNavigate();
  const session = useSession();
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[] | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const hasOAuthClientId = Boolean(client_id);
  const needsProjectSelection =
    scope?.split(" ").includes(ITERATE_PROJECT_SELECTION_SCOPE) ?? false;

  const oauthClientQuery = useQuery({
    queryKey: ["better-auth", "oauth2", "client", client_id],
    enabled: hasOAuthClientId,
    queryFn: () =>
      authClient.oauth2.publicClient({
        query: { client_id: client_id ?? "" },
      }),
  });

  const organizationsQuery = useQuery({
    queryKey: ["better-auth", "organizations"],
    queryFn: () => orpcClient.user.myOrganizations(),
  });

  const projectSelectionQuery = useQuery({
    queryKey: ["better-auth", "oauth2", "project-selection", organizationsQuery.data],
    enabled: needsProjectSelection && Boolean(organizationsQuery.data),
    queryFn: async () => {
      const organizations = organizationsQuery.data ?? [];
      return Promise.all(
        organizations.map(async (organization) => ({
          organization,
          projects: await orpcClient.project.list({ organizationSlug: organization.slug }),
        })),
      );
    },
  });

  const createOrganizationMutation = useMutation({
    mutationFn: (input: z.infer<typeof CreateOrganizationInput>) =>
      orpcClient.organization.create(input),
    onSuccess: async () => {
      setOrganizationName("");
      await organizationsQuery.refetch();
      if (!needsProjectSelection) {
        const result = await authClient.oauth2.continue({ postLogin: true });
        if (!result.url) {
          throw new Error("Could not continue the OAuth redirect");
        }

        window.location.href = result.url;
      }
    },
  });

  const saveSelectionMutation = useMutation({
    mutationFn: async (projectIds: string[]) => {
      if (!client_id) {
        throw new Error("Missing OAuth client ID");
      }

      await orpcClient.user.storeOAuthProjectSelection({ clientId: client_id, projectIds });
      const result = await authClient.oauth2.continue({ postLogin: true });
      if (!result.url) {
        throw new Error("Could not continue the OAuth redirect");
      }

      window.location.href = result.url;
      return result;
    },
  });

  const denyMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.oauth2.consent({ accept: false });
      if (!result.url) {
        throw new Error("Could not continue the OAuth redirect");
      }

      window.location.href = result.url;
      return result;
    },
  });

  const switchAccount = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: () => {
      const returnURL = window.location.pathname + window.location.search;
      navigate({ to: "/login", search: { redirect: returnURL } });
    },
  });

  const isLoadingOAuthClient = hasOAuthClientId && oauthClientQuery.isPending;
  const isLoadingProjectSelection = needsProjectSelection && projectSelectionQuery.isPending;

  if (isLoadingOAuthClient || organizationsQuery.isPending || isLoadingProjectSelection) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (hasOAuthClientId && oauthClientQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Something went wrong</CardTitle>
            <CardDescription>{oauthClientQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (organizationsQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Unable to load organizations</CardTitle>
            <CardDescription>{organizationsQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (needsProjectSelection && projectSelectionQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Unable to load projects</CardTitle>
            <CardDescription>{projectSelectionQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const client = oauthClientQuery.data;
  const user = session.user;
  const initials = getInitials(user.name ?? user.email);
  const organizations = organizationsQuery.data;
  const projectSelections = projectSelectionQuery.data ?? [];
  const allProjectIds = projectSelections.flatMap((selection) =>
    selection.projects.map((project) => project.id),
  );
  const effectiveSelectedProjectIds = selectedProjectIds ?? allProjectIds;
  const canContinue = effectiveSelectedProjectIds.length > 0;
  const isCreatingFirstOrganization = organizations.length === 0;
  const parsedOrganization = CreateOrganizationInput.safeParse({ name: organizationName });
  const isSubmitting =
    createOrganizationMutation.isPending ||
    saveSelectionMutation.isPending ||
    denyMutation.isPending ||
    switchAccount.isPending;

  if (isCreatingFirstOrganization) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            {client?.logo_uri && (
              <img src={client.logo_uri} alt="" className="mx-auto size-12 rounded-lg" />
            )}
            <CardTitle className="text-xl">Create your organization</CardTitle>
            <CardDescription className="text-xs">
              Create an organization to continue.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
              <Avatar>
                {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
            </div>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!parsedOrganization.success) return;
                createOrganizationMutation.mutate(parsedOrganization.data);
              }}
            >
              <FieldGroup>
                <Field data-invalid={!parsedOrganization.success && organizationName.length > 0}>
                  <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
                  <Input
                    id="organization-name"
                    name="organization-name"
                    placeholder="Acme"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    aria-invalid={!parsedOrganization.success && organizationName.length > 0}
                    disabled={isSubmitting}
                  />
                  {!parsedOrganization.success && organizationName.length > 0 ? (
                    <FieldError errors={parsedOrganization.error.issues} />
                  ) : null}
                </Field>
              </FieldGroup>
              {createOrganizationMutation.isError ? (
                <p className="text-sm text-destructive">
                  {createOrganizationMutation.error.message}
                </p>
              ) : null}

              <div className="flex gap-3">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={!parsedOrganization.success || isSubmitting}
                >
                  {createOrganizationMutation.isPending ? "Creating..." : "Create organization"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => denyMutation.mutate()}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {client?.logo_uri && (
            <img src={client.logo_uri} alt="" className="mx-auto size-12 rounded-lg" />
          )}
          <CardTitle className="text-xl">Choose project access</CardTitle>
          <CardDescription className="text-xs">
            {client?.client_name ?? "This application"} can only access the projects you select.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar>
                {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={isSubmitting}
              onClick={() => switchAccount.mutate()}
            >
              {switchAccount.isPending ? "Switching..." : "Switch"}
            </Button>
          </div>
        </CardContent>
        <Separator />
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Select one or more projects</p>
              <p className="text-xs text-muted-foreground">
                The access token will include these as `project:&lt;id&gt;` entries in its `scopes`
                claim.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => setSelectedProjectIds(allProjectIds)}
              >
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => setSelectedProjectIds([])}
              >
                None
              </Button>
            </div>
          </div>
          {projectSelections.length === 0 ? (
            <p className="text-sm text-muted-foreground">You do not have any projects to share.</p>
          ) : (
            <div className="space-y-3">
              {projectSelections.map((selection) => (
                <section key={selection.organization.id} className="space-y-2">
                  <div>
                    <p className="text-sm font-medium">{selection.organization.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {selection.projects.length} project
                      {selection.projects.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {selection.projects.map((project) => {
                      const checked = effectiveSelectedProjectIds.includes(project.id);

                      return (
                        <label
                          key={project.id}
                          aria-label={`Share project ${project.name}`}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={checked}
                            onChange={() =>
                              setSelectedProjectIds((current) => {
                                const next = new Set(current ?? allProjectIds);
                                if (next.has(project.id)) {
                                  next.delete(project.id);
                                } else {
                                  next.add(project.id);
                                }
                                return Array.from(next);
                              })
                            }
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{project.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{project.id}</p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
        <Separator />
        <CardFooter className="gap-3">
          <Button
            className="flex-1"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => denyMutation.mutate()}
          >
            Deny
          </Button>
          <Button
            className="flex-1"
            disabled={isSubmitting || !canContinue}
            onClick={() => saveSelectionMutation.mutate(effectiveSelectedProjectIds)}
          >
            {saveSelectionMutation.isPending ? "Continuing..." : "Continue"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
