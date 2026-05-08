import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
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
import { Textarea } from "@iterate-com/ui/components/textarea";
import { z } from "zod";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
      staleTime: 30_000,
    });
  },
  component: ProjectsIndexPage,
});

function formatMetadata(metadata: Record<string, unknown>) {
  return JSON.stringify(metadata);
}

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_CREATE_PROJECT_FORM_VALUES = {
  slug: "",
  metadataJson: '{\n  "owner": "os"\n}',
};

const CreateProjectForm = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(PROJECT_SLUG_PATTERN, "Slug must be lowercase kebab-case"),
  metadataJson: z
    .string()
    .trim()
    .min(1, "Metadata is required")
    .superRefine((value, ctx) => {
      const parsed = parseMetadataJson(value);
      if (!("message" in parsed)) return;

      ctx.addIssue({
        code: "custom",
        message: parsed.message,
      });
    }),
});

function parseMetadataJson(
  value: string,
): { ok: true; metadata: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, message: "Metadata must be valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Metadata must be a JSON object." };
  }

  return { ok: true, metadata: parsed as Record<string, unknown> };
}

function ProjectsIndexPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const { data: projectsData } = useQuery({
    ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
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
    defaultValues: DEFAULT_CREATE_PROJECT_FORM_VALUES,
    validators: {
      onChange: CreateProjectForm,
      onSubmit: CreateProjectForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = CreateProjectForm.parse(value);
      const metadata = parseMetadataJson(parsed.metadataJson);
      if ("message" in metadata) {
        return;
      }

      await createProject.mutateAsync({ slug: parsed.slug, metadata: metadata.metadata });
      form.reset();
    },
  });

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Projects</h2>
        <p className="text-sm text-muted-foreground">
          CRUD backed by sqlfu + D1, with type IDs and JSON metadata.
        </p>
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
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-start">
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

              <form.Field name="metadataJson">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Metadata</FieldLabel>
                      <Textarea
                        id={field.name}
                        name={field.name}
                        className="min-h-24 font-mono text-xs"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                      />
                      <FieldDescription>JSON object stored with the project.</FieldDescription>
                      {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                    </Field>
                  );
                }}
              </form.Field>
            </div>
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
        <div className="grid min-w-[1080px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
          <div>ID</div>
          <div>Slug</div>
          <div>Custom hostname</div>
          <div>Metadata</div>
          <div>Created</div>
          <div>Updated</div>
          <div />
        </div>
        {projectsData?.projects.map((project) => (
          <div
            key={project.id}
            className="grid min-w-[1080px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
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
            <code className="line-clamp-3 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {formatMetadata(project.metadata)}
            </code>
            <div className="text-xs text-muted-foreground">{project.createdAt}</div>
            <div className="text-xs text-muted-foreground">{project.updatedAt}</div>
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
        ))}
      </div>

      {projectsData && projectsData.projects.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects yet. Create one above.</p>
      )}
    </section>
  );
}
