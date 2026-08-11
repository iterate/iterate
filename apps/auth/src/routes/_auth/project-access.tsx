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
import { createServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { slugify } from "@iterate-com/shared/slug";
import { suggestOrganizationName } from "@iterate-com/shared/name-suggestions";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
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
import { parseConfig } from "../../config.ts";

// Runs on the server for both SSR and client navigations. The hostname base
// is this environment's deployed project domain (e.g. "iterate.app",
// "iterate-preview-3.app") — onboarding previews "<slug>.<base>" under it.
const getProjectAccessConfig = createServerFn({ method: "GET" }).handler(({ context }) => ({
  projectHostnameBase: parseConfig(context.cloudflare.env).projectHostnameBase,
}));

export const Route = createFileRoute("/_auth/project-access")({
  component: RouteComponent,
  validateSearch: z.looseObject({
    client_id: z.string().optional(),
    scope: z.string().optional(),
    redirect: z.string().optional(),
  }),
  loader: () => getProjectAccessConfig(),
});

const ProjectSlugInput = z
  .string()
  .trim()
  .min(1, "Project slug is required")
  .max(50)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and dashes")
  // The server normalizes slugs with slugify, which rewrites reserved and
  // letter-less values to "unnamed" — reject anything it would alter so the
  // stored slug always matches the homepage preview.
  .refine((slug) => slugify(slug) === slug, "Include a letter, and avoid reserved words");

const CreateOrganizationWithProjectInput = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(100),
  projectSlug: ProjectSlugInput,
});

const CreateProjectInput = z.object({
  organizationSlug: z.string().trim().min(1, "Organization is required"),
  slug: ProjectSlugInput,
});

function RouteComponent() {
  const { client_id, scope, redirect } = Route.useSearch();
  const { projectHostnameBase } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[] | null>(null);
  const [organizationName, setOrganizationName] = useState(() =>
    suggestOrganizationName({
      name: session.user.name,
      email: session.user.email,
    }),
  );
  // null = still deriving the first project's slug from the organization name.
  // Once the user edits the field (including clearing it), we keep their
  // value — empty string stays empty and does not snap back to the suggestion.
  const [projectSlugOverride, setProjectSlugOverride] = useState<string | null>(null);
  const [projectSlug, setProjectSlug] = useState("");
  const [selectedOrganizationSlug, setSelectedOrganizationSlug] = useState("");
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
  const hasOAuthClientId = Boolean(client_id);
  const needsProjectSelection =
    scope?.split(" ").includes(ITERATE_PROJECT_SELECTION_SCOPE) ?? false;
  const redirectTarget = resolveRedirectTarget(redirect);

  const oauthClientQuery = useQuery({
    ...oauthClientQueryOptions(client_id ?? ""),
    enabled: hasOAuthClientId,
  });

  const organizationsQuery = useQuery(organizationsQueryOptions());
  const projectSelectionOptions = projectSelectionQueryOptions(organizationsQuery.data ?? []);

  // Projects are needed for OAuth project selection AND to detect that a
  // non-OAuth visitor already finished setup (so we bounce them back out
  // instead of offering to create another project).
  const wantsProjects = needsProjectSelection || !hasOAuthClientId;
  const projectSelectionQuery = useQuery({
    ...projectSelectionOptions,
    enabled: wantsProjects && Boolean(organizationsQuery.data),
  });

  const createOrganizationWithProjectMutation = useMutation({
    mutationFn: async (input: z.infer<typeof CreateOrganizationWithProjectInput>) => {
      const organization = await orpcClient.organization.create({ name: input.name });
      try {
        return await orpcClient.project.create({
          organizationSlug: organization.slug,
          name: input.projectSlug,
          slug: input.projectSlug,
        });
      } catch (error) {
        // The organization now exists: refresh it so a retry lands on the
        // project-only form instead of failing on a duplicate organization.
        await queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey });
        throw error;
      }
    },
    onSuccess: async (project) => {
      if (!hasOAuthClientId) {
        // Back to the app that sent us here (usually the OS dashboard).
        return redirectAndStayPending(redirectTarget || "/");
      }
      if (!needsProjectSelection) {
        const result = await authClient.oauth2.continue({ postLogin: true });
        if (!result.url) {
          throw new Error("Could not continue the OAuth redirect");
        }

        return redirectAndStayPending(result.url);
      }
      setSelectedProjectIds([project.id]);
      await queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey });
      await queryClient.invalidateQueries({ queryKey: projectSelectionOptions.queryKey });
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: (input: z.infer<typeof CreateProjectInput>) =>
      orpcClient.project.create({
        organizationSlug: input.organizationSlug,
        name: input.slug,
        slug: input.slug,
      }),
    onSuccess: async (project) => {
      setProjectSlug("");
      setIsCreateProjectDialogOpen(false);
      if (!hasOAuthClientId) {
        // Back to the app that sent us here (usually the OS dashboard).
        return redirectAndStayPending(redirectTarget || "/");
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

      return redirectAndStayPending(preserveOAuthResourceSearchParam(result.url));
    },
  });

  const denyMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.oauth2.consent({ accept: false });
      if (!result.url) {
        throw new Error("Could not continue the OAuth redirect");
      }

      return redirectAndStayPending(result.url);
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
  const isLoadingProjectSelection = wantsProjects && projectSelectionQuery.isPending;

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

  if (wantsProjects && projectSelectionQuery.isError) {
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
  // Without an OAuth client this is plain first-run setup, so brand the
  // header as iterate rather than "This application".
  const clientName = client?.client_name ?? (hasOAuthClientId ? "This application" : "iterate");
  const organizations = organizationsQuery.data;
  const projectSelections = projectSelectionQuery.data ?? [];
  const allProjectIds = projectSelections.flatMap((selection) =>
    selection.projects.map((project) => project.id),
  );
  const hasProjects = allProjectIds.length > 0;
  const effectiveSelectedProjectIds = selectedProjectIds ?? allProjectIds;
  const canContinue = effectiveSelectedProjectIds.length > 0;
  const isCreatingFirstOrganization = organizations.length === 0;
  const suggestedProjectSlug = organizationName.trim() ? slugify(organizationName) : "";
  const firstProjectSlug = projectSlugOverride ?? suggestedProjectSlug;
  const parsedOrganizationWithProject = CreateOrganizationWithProjectInput.safeParse({
    name: organizationName,
    projectSlug: firstProjectSlug,
  });
  const organizationNameIssues =
    !parsedOrganizationWithProject.success && organizationName.length > 0
      ? parsedOrganizationWithProject.error.issues.filter((issue) => issue.path[0] === "name")
      : [];
  const firstProjectSlugIssues =
    !parsedOrganizationWithProject.success && firstProjectSlug.length > 0
      ? parsedOrganizationWithProject.error.issues.filter(
          (issue) => issue.path[0] === "projectSlug",
        )
      : [];
  const effectiveOrganizationSlug = selectedOrganizationSlug || organizations[0]?.slug || "";
  const parsedProject = CreateProjectInput.safeParse({
    organizationSlug: effectiveOrganizationSlug,
    slug: projectSlug,
  });
  const isSubmitting =
    createOrganizationWithProjectMutation.isPending ||
    createProjectMutation.isPending ||
    saveSelectionMutation.isPending ||
    denyMutation.isPending ||
    switchAccount.isPending;

  const createProjectFormProps = {
    organizations,
    projectSlug,
    projectHostnameBase,
    selectedOrganizationSlug: effectiveOrganizationSlug,
    isSubmitting,
    isCreating: createProjectMutation.isPending,
    isValid: parsedProject.success,
    error: !parsedProject.success && projectSlug.length > 0 ? parsedProject.error.issues : null,
    // The combined first-run mutation can leave an error behind when the
    // organization was created but the project was not (the UI then falls to
    // this project-only form) — keep that failure visible for the retry.
    mutationError: createProjectMutation.isError
      ? createProjectMutation.error.message
      : createOrganizationWithProjectMutation.isError
        ? createOrganizationWithProjectMutation.error.message
        : null,
    onProjectSlugChange: setProjectSlug,
    onOrganizationSlugChange: setSelectedOrganizationSlug,
    onSubmit: () => {
      if (!parsedProject.success) return;
      createProjectMutation.mutate(parsedProject.data);
    },
  };

  if (!hasOAuthClientId && hasProjects) {
    if (redirectTarget) {
      return <ExternalRedirect href={redirectTarget} />;
    }
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
            <CardDescription>
              Name your organization and your first project comes with it.
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

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!parsedOrganizationWithProject.success) return;
                createOrganizationWithProjectMutation.mutate(parsedOrganizationWithProject.data);
              }}
            >
              <FieldGroup>
                <Field data-invalid={organizationNameIssues.length > 0}>
                  <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
                  <Input
                    id="organization-name"
                    name="organization-name"
                    placeholder="Acme"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    aria-invalid={organizationNameIssues.length > 0}
                    disabled={isSubmitting}
                  />
                  {organizationNameIssues.length > 0 ? (
                    <FieldError errors={organizationNameIssues} />
                  ) : null}
                </Field>
                <Field data-invalid={firstProjectSlugIssues.length > 0}>
                  <FieldLabel htmlFor="first-project-slug">Project slug</FieldLabel>
                  <Input
                    id="first-project-slug"
                    name="first-project-slug"
                    placeholder="acme"
                    value={firstProjectSlug}
                    onChange={(event) => setProjectSlugOverride(event.target.value)}
                    aria-invalid={firstProjectSlugIssues.length > 0}
                    disabled={isSubmitting}
                  />
                  <FieldDescription>
                    Your project homepage will be under{" "}
                    <span className="whitespace-nowrap font-medium text-foreground">
                      {firstProjectSlug || "your-project"}.{projectHostnameBase}
                    </span>
                  </FieldDescription>
                  {firstProjectSlugIssues.length > 0 ? (
                    <FieldError errors={firstProjectSlugIssues} />
                  ) : null}
                </Field>
              </FieldGroup>
              {createOrganizationWithProjectMutation.isError ? (
                <p className="text-sm text-destructive">
                  {createOrganizationWithProjectMutation.error.message}
                </p>
              ) : null}

              <div className="flex gap-3">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={!parsedOrganizationWithProject.success || isSubmitting}
                >
                  {createOrganizationWithProjectMutation.isPending ? "Creating..." : "Get started"}
                </Button>
                {hasOAuthClientId ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSubmitting}
                    onClick={() => denyMutation.mutate()}
                  >
                    Cancel
                  </Button>
                ) : null}
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
            {hasOAuthClientId ? (
              <Button
                className="flex-1"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => denyMutation.mutate()}
              >
                Cancel
              </Button>
            ) : null}
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
  projectSlug: string;
  projectHostnameBase: string;
  selectedOrganizationSlug: string;
  isSubmitting: boolean;
  isCreating: boolean;
  isValid: boolean;
  error: z.core.$ZodIssue[] | null;
  mutationError: string | null;
  showSubmitButton?: boolean;
  onProjectSlugChange: (value: string) => void;
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
          <FieldLabel htmlFor="project-slug">Project slug</FieldLabel>
          <Input
            id="project-slug"
            name="project-slug"
            placeholder="acme"
            value={props.projectSlug}
            onChange={(event) => props.onProjectSlugChange(event.target.value)}
            aria-invalid={Boolean(props.error)}
            disabled={props.isSubmitting}
          />
          <FieldDescription>
            Your project homepage will be under{" "}
            <span className="whitespace-nowrap font-medium text-foreground">
              {props.projectSlug || "your-project"}.{props.projectHostnameBase}
            </span>
          </FieldDescription>
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

/**
 * Leave the page and keep the caller's mutation pending until the browser
 * actually unloads. A bare `window.location.href = ...` returns immediately,
 * react-query flips `isPending` off, and every `isSubmitting`-gated button
 * re-enables mid-navigation — "Create project" then invites a double submit.
 * Returning this never-resolving promise (from `onSuccess`, or awaited in a
 * `mutationFn`) keeps the mutation pending for the page's remaining lifetime.
 */
function redirectAndStayPending(href: string): Promise<never> {
  window.location.href = href;
  return new Promise<never>(() => {});
}

/**
 * Validates the `?redirect=` search param (set by the app that sent the user
 * here, e.g. the OS dashboard) so setup can hand the user back when done.
 * Only plain http(s) URLs are honored.
 */
function resolveRedirectTarget(redirect: string | undefined): string | null {
  if (!redirect) return null;
  try {
    const url = new URL(redirect);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ExternalRedirect(props: { href: string }) {
  useEffect(() => {
    window.location.replace(props.href);
  }, [props.href]);
  return null;
}
