import { useForm } from "@tanstack/react-form";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os-contract";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { z } from "zod";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import { orpc } from "~/orpc/client.ts";

type ProjectsListData = { projects: Project[]; total: number };

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CreateProjectSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(PROJECT_SLUG_PATTERN, "Slug must be lowercase kebab-case"),
});

export function CreateProjectForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: async (project) => {
        cacheCreatedProjectQueries({ project, queryClient });
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
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

  const form = useForm({
    defaultValues: { slug: "" },
    validators: {
      onChange: CreateProjectSchema,
      onSubmit: CreateProjectSchema,
    },
    onSubmit: async ({ value }) => {
      const parsed = CreateProjectSchema.parse(value);
      await createProject.mutateAsync({ slug: parsed.slug });
      form.reset();
    },
  });

  return (
    <form
      className="max-w-sm space-y-4"
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
          <Button type="submit" disabled={!canSubmit || isSubmitting || createProject.isPending}>
            {isSubmitting || createProject.isPending ? "Creating..." : "Create project"}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

export function cacheCreatedProjectQueries(input: {
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
    isOrphanedProjectFromAuthService: input.project.isOrphanedProjectFromAuthService,
  };

  for (const listInput of [
    { limit: 20, offset: 0 },
    { limit: 100, offset: 0 },
  ] as const) {
    const listQuery = projectsListQueryOptions(listInput);
    input.queryClient.setQueryData<ProjectsListData>(listQuery.queryKey, (existing) => {
      if (!existing) return existing;
      if (existing.projects.some((project) => project.id === input.project.id)) {
        return {
          ...existing,
          projects: existing.projects.map((project) =>
            project.id === input.project.id ? listProject : project,
          ),
        };
      }

      return {
        ...existing,
        projects: [listProject, ...existing.projects].slice(0, listInput.limit),
        total: existing.total + 1,
      };
    });
  }
}
