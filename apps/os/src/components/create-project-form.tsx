import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAuthClient } from "@iterate-com/auth/client";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { toast } from "@iterate-com/ui/components/sonner";
import { z } from "zod";
import { projectsListQueryKey } from "~/lib/projects-query.ts";
import { connectItxBrowser, reconnectItx } from "~/itx/itx-react.tsx";

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CreateProjectInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(PROJECT_SLUG_PATTERN, "Slug must be lowercase kebab-case"),
  organizationSlug: z.string(),
});

export function CreateProjectForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { refresh, session } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];
  const createProject = useMutation({
    mutationFn: async (input: { slug: string; organizationSlug: string }) => {
      // Straight through the itx session: create registers the project with
      // the auth worker (org grant -> claims) and runs the engine bootstrap
      // saga, then widens THIS socket's access to the new project.
      const itx = await connectItxBrowser();
      const project = itx.projects.create({
        slug: input.slug,
        ...(input.organizationSlug ? { organizationSlug: input.organizationSlug } : {}),
      });
      const description = await project.describe();
      // The auth worker may normalize (slugify) the requested slug; the
      // same-socket list carries the canonical record for the just-widened
      // project, so read it back rather than echoing the submitted slug.
      const entries = await itx.projects.list();
      const entry = entries.find((candidate) => candidate.id === description.projectId);
      return { id: description.projectId, slug: entry?.slug ?? input.slug };
    },
    onSuccess: async (project) => {
      // Refresh the browser auth session so it carries the new project's
      // claim BEFORE navigating to the project-scoped route (#1516); without
      // this the project route loads before the session knows the project.
      await refresh({ force: true });
      // Drop the global itx socket so it re-dials with the refreshed claims —
      // otherwise itx.projects.list (connect-time principal) omits this project.
      reconnectItx();
      await queryClient.invalidateQueries({ queryKey: projectsListQueryKey });
      await router.invalidate({ sync: true });
      // New projects land in the agent onboarding flow (origin/main UX).
      await router.navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: {
          _splat: "/agents/onboarding",
          projectSlug: project.slug,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const form = useForm({
    defaultValues: { slug: "", organizationSlug: organizations[0]?.slug ?? "" },
    validators: {
      onChange: CreateProjectInput,
      onSubmit: CreateProjectInput,
    },
    onSubmit: async ({ value }) => {
      const parsed = CreateProjectInput.parse(value);
      await createProject.mutateAsync({
        slug: parsed.slug,
        organizationSlug: parsed.organizationSlug,
      });
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
        {organizations.length > 1 ? (
          <form.Field name="organizationSlug">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Organization</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => field.handleChange(value ?? "")}
                >
                  <SelectTrigger id={field.name}>
                    <SelectValue placeholder="Select an organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((organization) => (
                      <SelectItem key={organization.slug} value={organization.slug}>
                        {organization.name ?? organization.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>The organization that will own this project.</FieldDescription>
              </Field>
            )}
          </form.Field>
        ) : null}
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
