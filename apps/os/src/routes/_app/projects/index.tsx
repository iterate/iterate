import { useForm } from "@tanstack/react-form";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { useState } from "react";
import type { Project } from "@iterate-com/os-contract";
import { useConfig } from "@iterate-com/ui/apps/config";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@iterate-com/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { z } from "zod";
import type { AppConfig } from "~/app.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { orpc } from "~/orpc/client.ts";

type PublicConfig = PublicAppConfig<AppConfig>;
type ProjectsListData = { projects: Project[]; total: number };

export const Route = createFileRoute("/_app/projects/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
      staleTime: 30_000,
    });
  },
  component: ProjectsIndexPage,
});

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CreateProjectForm = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(PROJECT_SLUG_PATTERN, "Slug must be lowercase kebab-case"),
});

function buildProjectHostname(input: {
  slug: string;
  customHostname: string | null;
  projectHostnameBases: readonly string[];
}) {
  if (input.customHostname) return input.customHostname;
  const base = input.projectHostnameBases[0];
  if (!base) return null;
  return `${input.slug}.${normalizeProjectHostnameBase(base)}`;
}

function ProjectsIndexPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const config = useConfig<PublicConfig>();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const { data: projectsData } = useQuery({
    ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: async (project) => {
        cacheCreatedProjectQueries({ project, queryClient });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
        setIsCreateDialogOpen(false);
        await router.invalidate({ sync: true });
        await router.navigate({
          to: "/projects/$projectSlug",
          params: {
            projectSlug: project.slug,
          },
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deleteProject = useMutation(
    orpc.projects.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const form = useForm({
    defaultValues: { slug: "" },
    validators: {
      onChange: CreateProjectForm,
      onSubmit: CreateProjectForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = CreateProjectForm.parse(value);
      await createProject.mutateAsync({ slug: parsed.slug });
      form.reset();
    },
  });

  const hasProjects = (projectsData?.projects.length ?? 0) > 0;
  const createProjectDialog = (triggerLabel = "New project") => (
    <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
      <DialogTrigger
        render={
          <Button type="button" size="sm">
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Pick a slug for your project. You can configure hostnames later.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="slug">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Slug</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      placeholder="project-slug"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>Lowercase letters, numbers, and hyphens.</FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
          <DialogFooter showCloseButton>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  disabled={!canSubmit || isSubmitting || createProject.isPending}
                >
                  {isSubmitting || createProject.isPending ? "Creating..." : "Create project"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return (
    <section className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Projects</h2>
          <p className="text-sm text-muted-foreground">Create and manage projects.</p>
        </div>
        {hasProjects ? createProjectDialog() : null}
      </div>

      {!hasProjects ? (
        <div className="rounded-xl border border-dashed bg-card/60 px-6 py-14 text-center">
          <div className="mx-auto flex max-w-md flex-col items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <FolderPlus className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">No projects yet</h3>
              <p className="text-sm text-muted-foreground">
                Create your first project to start using OS.
              </p>
            </div>
            {createProjectDialog("Create new project")}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <div className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div>ID</div>
            <div>Slug</div>
            <div>Custom hostname</div>
            <div>Hostname</div>
            <div>Created</div>
            <div />
          </div>
          {projectsData?.projects.map((project) => {
            const hostname = buildProjectHostname({
              slug: project.slug,
              customHostname: project.customHostname,
              projectHostnameBases: config.projectHostnameBases,
            });

            return (
              <div
                key={project.id}
                className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
              >
                <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
                <Link
                  to="/projects/$projectSlug"
                  params={{
                    projectSlug: project.slug,
                  }}
                  className="truncate font-medium hover:underline"
                >
                  {project.slug}
                </Link>
                <div className="truncate text-xs text-muted-foreground">
                  {project.customHostname ?? "None"}
                </div>
                <div className="truncate text-xs">
                  {hostname ? (
                    <a
                      href={`https://${hostname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline"
                    >
                      {hostname}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{project.createdAt}</div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteProject.mutate({ id: project.id })}
                  disabled={deleteProject.isPending && deleteProject.variables?.id === project.id}
                >
                  {deleteProject.isPending && deleteProject.variables?.id === project.id
                    ? "Deleting..."
                    : "Delete"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function cacheCreatedProjectQueries(input: {
  project: Project & { ingressUrl: string };
  queryClient: QueryClient;
}) {
  const findQuery = orpc.projects.find.queryOptions({ input: { id: input.project.id } });
  const findBySlugQuery = orpc.projects.findBySlug.queryOptions({
    input: { slug: input.project.slug },
  });
  input.queryClient.setQueryData(findQuery.queryKey, input.project);
  input.queryClient.setQueryData(findBySlugQuery.queryKey, input.project);
  const listProject: Project = {
    id: input.project.id,
    slug: input.project.slug,
    customHostname: input.project.customHostname,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
  };

  for (const listInput of [
    { limit: 20, offset: 0 },
    { limit: 100, offset: 0 },
  ] as const) {
    const listQuery = orpc.projects.list.queryOptions({ input: listInput });
    input.queryClient.setQueryData<ProjectsListData>(listQuery.queryKey, (existing) => {
      if (!existing) return existing;
      if (existing.projects.some((project) => project.id === input.project.id)) return existing;

      return {
        ...existing,
        projects: [listProject, ...existing.projects].slice(0, listInput.limit),
        total: existing.total + 1,
      };
    });
  }
}
