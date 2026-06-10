import { Button } from "@iterate-com/ui/components/button";
import { ITERATE_PROJECT_SELECTION_SCOPE } from "@iterate-com/shared/auth-claims";
import { Badge } from "@iterate-com/ui/components/badge";
import {
  OAUTH_RESOURCE_PARAMETER,
  copyMissingSearchParams,
} from "@iterate-com/shared/oauth-resource";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@iterate-com/ui/components/dialog";
import { Separator } from "@iterate-com/ui/components/separator";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, FieldError, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { z } from "zod/v4";
import { authClient, useSession } from "../../utils/auth-client.ts";
import {
  oauthClientQueryOptions,
  organizationsQueryOptions,
  projectSelectionQueryOptions,
} from "../../utils/auth-query-options.ts";
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

const CreateProjectInput = z.object({
  organizationSlug: z.string().trim().min(1, "Organization is required"),
  name: z.string().trim().min(1, "Project name is required").max(100),
});

function RouteComponent() {
  const { client_id, scope } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[] | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [selectedOrganizationSlug, setSelectedOrganizationSlug] = useState("");
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
  const hasOAuthClientId = Boolean(client_id);
  const needsProjectSelection =
    scope?.split(" ").includes(ITERATE_PROJECT_SELECTION_SCOPE) ?? false;

  const oauthClientQuery = useQuery({
    ...oauthClientQueryOptions(client_id ?? ""),
    enabled: hasOAuthClientId,
  });

  const organizationsQuery = useQuery(organizationsQueryOptions());
  const projectSelectionOptions = projectSelectionQueryOptions(organizationsQuery.data ?? []);

  const projectSelectionQuery = useQuery({
    ...projectSelectionOptions,
    enabled: needsProjectSelection && Boolean(organizationsQuery.data),
  });

  const createOrganizationMutation = useMutation({
    mutationFn: (input: z.infer<typeof CreateOrganizationInput>) =>
      orpcClient.organization.create(input),
    onSuccess: async () => {
      setOrganizationName("");
      await queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey });
      if (!hasOAuthClientId) {
        await navigate({ to: "/" });
        return;
      }
      if (!needsProjectSelection) {
        const result = await authClient.oauth2.continue({ postLogin: true });
        if (!result.url) {
          throw new Error("Could not continue the OAuth redirect");
        }

        window.location.href = result.url;
      }
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: (input: z.infer<typeof CreateProjectInput>) => orpcClient.project.create(input),
    onSuccess: async (project) => {
      setProjectName("");
      setIsCreateProjectDialogOpen(false);
      if (!hasOAuthClientId) {
        await queryClient.invalidateQueries({ queryKey: projectSelectionOptions.queryKey });
        await navigate({ to: "/" });
        return;
      }
      setSelectedProjectIds((current) => {
        const existingProjectIds =
          projectSelectionQuery.data?.flatMap((selection) =>
            selection.projects.map((project) => project.id),
          ) ?? [];
        const next = new Set(current ?? existingProjectIds);
        next.add(project.id);
        return Array.from(next);
      });
      await queryClient.invalidateQueries({ queryKey: projectSelectionOptions.queryKey });
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

      window.location.href = preserveOAuthResourceSearchParam(result.url);
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
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <div className="h-12 w-12 rounded-lg bg-muted" />
            <div className="h-5 w-44 rounded bg-muted" />
            <div className="h-4 w-72 max-w-full rounded bg-muted" />
          </CardHeader>
          <Separator />
          <CardContent className="space-y-3">
            <div className="h-14 rounded-lg bg-muted" />
            <div className="h-32 rounded-lg bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (hasOAuthClientId && oauthClientQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Something went wrong</CardTitle>
            <CardDescription>{oauthClientQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (organizationsQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Unable to load organizations</CardTitle>
            <CardDescription>{organizationsQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (needsProjectSelection && projectSelectionQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
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
  const clientName = client?.client_name ?? "This application";
  const organizations = organizationsQuery.data;
  const projectSelections = projectSelectionQuery.data ?? [];
  const allProjectIds = projectSelections.flatMap((selection) =>
    selection.projects.map((project) => project.id),
  );
  const hasProjects = allProjectIds.length > 0;
  const effectiveSelectedProjectIds = selectedProjectIds ?? allProjectIds;
  const canContinue = effectiveSelectedProjectIds.length > 0;
  const isCreatingFirstOrganization = organizations.length === 0;
  const parsedOrganization = CreateOrganizationInput.safeParse({ name: organizationName });
  const effectiveOrganizationSlug = selectedOrganizationSlug || organizations[0]?.slug || "";
  const parsedProject = CreateProjectInput.safeParse({
    organizationSlug: effectiveOrganizationSlug,
    name: projectName,
  });
  const isSubmitting =
    createOrganizationMutation.isPending ||
    createProjectMutation.isPending ||
    saveSelectionMutation.isPending ||
    denyMutation.isPending ||
    switchAccount.isPending;

  const createProjectFormProps = {
    organizations,
    projectName,
    selectedOrganizationSlug: effectiveOrganizationSlug,
    isSubmitting,
    isCreating: createProjectMutation.isPending,
    isValid: parsedProject.success,
    error: !parsedProject.success && projectName.length > 0 ? parsedProject.error.issues : null,
    mutationError: createProjectMutation.isError ? createProjectMutation.error.message : null,
    onProjectNameChange: setProjectName,
    onOrganizationSlugChange: setSelectedOrganizationSlug,
    onSubmit: () => {
      if (!parsedProject.success) return;
      createProjectMutation.mutate(parsedProject.data);
    },
  };

  if (!hasOAuthClientId && hasProjects) {
    return <Navigate to="/" />;
  }

  if (isCreatingFirstOrganization) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="gap-4">
            <AuthFlowHeader
              logoUri={client?.logo_uri}
              name={clientName}
              label={hasOAuthClientId ? "Project access" : "Setup"}
            />
            <CardTitle className="text-xl">Create your organization</CardTitle>
            <CardDescription>Start with the team name people recognize.</CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4">
            <SignedInUserRow
              user={user}
              initials={initials}
              isSubmitting={isSubmitting}
              isSwitching={switchAccount.isPending}
              onSwitch={() => switchAccount.mutate()}
            />

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

  if (!hasProjects) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="gap-4">
            <AuthFlowHeader
              logoUri={client?.logo_uri}
              name={clientName}
              label={hasOAuthClientId ? "Project access" : "Setup"}
            />
            <CardTitle className="text-xl">Create a project</CardTitle>
            <CardDescription>
              {hasOAuthClientId
                ? `Create a project before choosing access for ${clientName}.`
                : "Create a project to finish setup."}
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4">
            <SignedInUserRow
              user={user}
              initials={initials}
              isSubmitting={isSubmitting}
              isSwitching={switchAccount.isPending}
              onSwitch={() => switchAccount.mutate()}
            />
            <CreateProjectForm
              {...createProjectFormProps}
              id="create-first-project-form"
              showSubmitButton={false}
            />
          </CardContent>
          <Separator />
          <CardFooter className="gap-3">
            <Button
              className="flex-1"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => denyMutation.mutate()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-first-project-form"
              className="flex-1"
              disabled={!parsedProject.success || isSubmitting}
            >
              {createProjectMutation.isPending ? "Creating..." : "Create project"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="gap-4">
          <AuthFlowHeader logoUri={client?.logo_uri} name={clientName} label="Project access" />
          <CardTitle className="text-xl">Choose project access</CardTitle>
          <CardDescription>{clientName} can only use the projects you select.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent>
          <SignedInUserRow
            user={user}
            initials={initials}
            isSubmitting={isSubmitting}
            isSwitching={switchAccount.isPending}
            onSwitch={() => switchAccount.mutate()}
          />
        </CardContent>
        <Separator />
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Projects</p>
              <p className="text-xs text-muted-foreground">
                {effectiveSelectedProjectIds.length === 0
                  ? "No projects selected."
                  : `${effectiveSelectedProjectIds.length} selected.`}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Dialog open={isCreateProjectDialogOpen} onOpenChange={setIsCreateProjectDialogOpen}>
                <DialogTrigger
                  render={
                    <Button type="button" size="sm" variant="outline" disabled={isSubmitting}>
                      New project
                    </Button>
                  }
                />
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create project</DialogTitle>
                    <DialogDescription>
                      Add a project, then decide whether to include it.
                    </DialogDescription>
                  </DialogHeader>
                  <CreateProjectForm {...createProjectFormProps} />
                </DialogContent>
              </Dialog>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={() => setSelectedProjectIds(allProjectIds)}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={() => setSelectedProjectIds([])}
                >
                  Clear
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-4">
            {projectSelections.map((selection) => (
              <section key={selection.organization.id} className="rounded-lg border">
                <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
                  <p className="text-sm font-medium">{selection.organization.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {selection.projects.length} project
                    {selection.projects.length === 1 ? "" : "s"}
                  </p>
                </div>
                {selection.projects.length > 0 ? (
                  <div className="divide-y">
                    {selection.projects.map((project) => {
                      const checked = effectiveSelectedProjectIds.includes(project.id);

                      return (
                        <label
                          key={project.id}
                          aria-label={`Share project ${project.name}`}
                          className={[
                            "flex cursor-pointer items-center gap-3 px-3 py-3 transition-colors",
                            checked ? "bg-primary/5" : "hover:bg-muted/40",
                          ].join(" ")}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() =>
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
                            disabled={isSubmitting}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{project.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {selection.organization.name}
                            </p>
                          </div>
                          {checked ? <Badge variant="secondary">Selected</Badge> : null}
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
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

function SignedInUserRow(props: {
  user: {
    name?: string | null;
    email: string;
    image?: string | null;
  };
  initials: string;
  isSubmitting: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar>
          {props.user.image && (
            <AvatarImage src={props.user.image} alt={props.user.name ?? props.user.email} />
          )}
          <AvatarFallback>{props.initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{props.user.name ?? "User"}</p>
          <p className="truncate text-xs text-muted-foreground">{props.user.email}</p>
        </div>
      </div>
      <Button variant="ghost" size="sm" disabled={props.isSubmitting} onClick={props.onSwitch}>
        {props.isSwitching ? "Switching..." : "Switch"}
      </Button>
    </div>
  );
}

function preserveOAuthResourceSearchParam(rawUrl: string) {
  return copyMissingSearchParams({
    targetUrl: rawUrl,
    sourceSearch: window.location.search,
    paramNames: [OAUTH_RESOURCE_PARAMETER],
    baseUrl: window.location.origin,
  }).toString();
}

function AuthFlowHeader(props: { logoUri?: string | null; name: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <ClientMark logoUri={props.logoUri} name={props.name} />
      <div className="min-w-0">
        <Badge variant="outline">{props.label}</Badge>
        <p className="mt-2 truncate text-sm font-medium">{props.name}</p>
      </div>
    </div>
  );
}

function ClientMark(props: { logoUri?: string | null; name: string }) {
  if (props.logoUri) {
    return <img src={props.logoUri} alt="" className="size-12 shrink-0 rounded-lg border" />;
  }

  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold">
      {getInitials(props.name)}
    </div>
  );
}

function CreateProjectForm(props: {
  id?: string;
  className?: string;
  organizations: { id: string; name: string; slug: string }[];
  projectName: string;
  selectedOrganizationSlug: string;
  isSubmitting: boolean;
  isCreating: boolean;
  isValid: boolean;
  error: z.core.$ZodIssue[] | null;
  mutationError: string | null;
  showSubmitButton?: boolean;
  onProjectNameChange: (value: string) => void;
  onOrganizationSlugChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      id={props.id}
      className={props.className ? `space-y-3 ${props.className}` : "space-y-3"}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-organization">Organization</FieldLabel>
          <NativeSelect
            id="project-organization"
            className="w-full"
            value={props.selectedOrganizationSlug}
            onChange={(event) => props.onOrganizationSlugChange(event.target.value)}
            disabled={props.organizations.length === 0 || props.isSubmitting}
          >
            {props.organizations.map((organization) => (
              <NativeSelectOption key={organization.id} value={organization.slug}>
                {organization.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field data-invalid={Boolean(props.error)}>
          <FieldLabel htmlFor="project-name">Project name</FieldLabel>
          <Input
            id="project-name"
            name="project-name"
            placeholder="MCP Alpha"
            value={props.projectName}
            onChange={(event) => props.onProjectNameChange(event.target.value)}
            aria-invalid={Boolean(props.error)}
            disabled={props.isSubmitting}
          />
          {props.error ? <FieldError errors={props.error} /> : null}
        </Field>
      </FieldGroup>
      {props.mutationError ? (
        <p className="text-sm text-destructive">{props.mutationError}</p>
      ) : null}
      {(props.showSubmitButton ?? true) ? (
        <Button type="submit" size="sm" disabled={!props.isValid || props.isSubmitting}>
          {props.isCreating ? "Creating..." : "Create project"}
        </Button>
      ) : null}
    </form>
  );
}
