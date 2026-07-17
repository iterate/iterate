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
import { ONBOARDING_AGENT_PATH } from "~/lib/onboarding-agent.ts";
import { projectsListQueryKey } from "~/lib/projects-query.ts";
import { connectIterateSession, reconnectIterateSession } from "~/itx/itx-react.tsx";

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
      const session = await connectIterateSession();
      // Fast path: resolve as soon as the project EXISTS — the bootstrap saga
      // keeps running behind the handle, and the project home page plays its
      // progress live from processor pushes until `state.created` flips.
      const project = session.projects.create({
        slug: input.slug,
        waitUntilReady: false,
        ...(input.organizationSlug ? { organizationSlug: input.organizationSlug } : {}),
      });
      // ONE pipelined round trip, then navigate: __describe() rides the create
      // pipeline, so the only wait is create itself (auth registration +
      // bootstrap appends). Deliberately NOT awaited here: projects.list() —
      // it probes engine existence for every project the caller owns, which
      // costs whole seconds and is exactly the "weird delay" this path had.
      const description = await project.__describe();
      // The form validates strict kebab-case, so the auth worker's slug
      // normalization is an identity for UI creates; the background task
      // below still reconciles against the canonical record.
      return { id: description.projectId, slug: input.slug };
    },
    onSuccess: (project) => {
      // Onto the onboarding agent URL immediately. The stream page can render
      // while the bootstrap saga and onboarding agent birth catch up behind it.
      // The project route resolves without the refreshed session: create primes
      // the server-side project directory, which is the auth fallback for
      // exactly this claims-lag window.
      void router.navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: { projectSlug: project.slug, _splat: ONBOARDING_AGENT_PATH },
        search: {},
      });
      // Session catch-up runs BEHIND the navigation: refresh the browser auth
      // session so its claims carry the new project, reconnect the one itx
      // socket so it re-dials with them (a semantic reset — see reconnectIterateSession),
      // and refresh the project list.
      void (async () => {
        await refresh({ force: true });
        reconnectIterateSession();
        await queryClient.invalidateQueries({ queryKey: projectsListQueryKey });
        await router.invalidate();
        // Belt and braces: if the auth worker normalized the slug after all,
        // hop to the canonical URL (the checklist state is server-side, so
        // nothing is lost).
        const session = await connectIterateSession();
        const entry = (await session.projects.list()).find(
          (candidate) => candidate.id === project.id,
        );
        if (entry != null && entry.slug !== project.slug) {
          void router.navigate({
            to: "/projects/$projectSlug/agents/streams/$",
            params: { projectSlug: entry.slug, _splat: ONBOARDING_AGENT_PATH },
            search: {},
            replace: true,
          });
        }
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
