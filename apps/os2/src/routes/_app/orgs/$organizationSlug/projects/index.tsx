import { useForm } from "@tanstack/react-form";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os2-contract";
import { useConfig } from "@iterate-com/ui/apps/config";
import { Button } from "@iterate-com/ui/components/button";
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

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/")({
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
  const params = Route.useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const config = useConfig<PublicConfig>();
  const { data: projectsData } = useQuery({
    ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: async (project) => {
        cacheCreatedProjectQueries({ project, queryClient });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
        await router.invalidate({ sync: true });
        await router.navigate({
          to: "/orgs/$organizationSlug/projects/$projectSlug",
          params: {
            organizationSlug: params.organizationSlug,
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

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Projects</h2>
        <p className="text-sm text-muted-foreground">Create and manage projects.</p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <form
          className="flex flex-col gap-4"
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

          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button
                className="self-start"
                type="submit"
                size="sm"
                disabled={!canSubmit || isSubmitting || createProject.isPending}
              >
                {isSubmitting || createProject.isPending ? "Adding..." : "Add"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>

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
                to="/orgs/$organizationSlug/projects/$projectSlug"
                params={{
                  organizationSlug: params.organizationSlug,
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

      {projectsData && projectsData.projects.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects yet. Create one above.</p>
      )}
    </section>
  );
}

function cacheCreatedProjectQueries(input: { project: Project; queryClient: QueryClient }) {
  const findQuery = orpc.projects.find.queryOptions({ input: { id: input.project.id } });
  const findBySlugQuery = orpc.projects.findBySlug.queryOptions({
    input: { slug: input.project.slug },
  });
  input.queryClient.setQueryData(findQuery.queryKey, input.project);
  input.queryClient.setQueryData(findBySlugQuery.queryKey, input.project);

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
        projects: [input.project, ...existing.projects].slice(0, listInput.limit),
        total: existing.total + 1,
      };
    });
  }
}
