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
      // Fast path: resolve as soon as the project EXISTS — the bootstrap saga
      // keeps running behind the handle, and the project home page plays its
      // progress live from processor pushes until `state.created` flips.
      const project = itx.projects.create({
        slug: input.slug,
        waitUntilCreated: false,
        ...(input.organizationSlug ? { organizationSlug: input.organizationSlug } : {}),
      });
      // ONE pipelined round trip, then navigate. The canonical slug (the auth
      // worker may normalize the requested one) comes back on the same-socket
      // list, which already sees the just-widened project.
      const [description, entries] = await Promise.all([project.describe(), itx.projects.list()]);
      const entry = entries.find((candidate) => candidate.id === description.projectId);
      return { id: description.projectId, slug: entry?.slug ?? input.slug };
    },
    onSuccess: (project) => {
      // Into the project IMMEDIATELY — the home page plays the creation
      // checklist live and `welcome` hands over to the onboarding agent when
      // the saga lands. The project route resolves without the refreshed
      // session: create primes the server-side project directory, which is
      // the auth fallback for exactly this claims-lag window.
      void router.navigate({
        to: "/projects/$projectSlug",
        params: { projectSlug: project.slug },
        search: { welcome: true },
      });
      // Session catch-up runs BEHIND the navigation: refresh the browser auth
      // session so its claims carry the new project, drop the global itx
      // socket so it re-dials with them (project sockets are untouched — the
      // checklist's subscription keeps running), and refresh the project list.
      void (async () => {
        await refresh({ force: true });
        reconnectItx();
        await queryClient.invalidateQueries({ queryKey: projectsListQueryKey });
        await router.invalidate();
      })().catch(() => {
        // Claims catch up on the next token refresh regardless; the directory
        // fallback keeps the project usable in the meantime.
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
