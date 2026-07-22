import { useEffect, useState } from "react";
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
import { connectIterateSession, reconnectIterateSession } from "iterate/sdk/itx/react";
import { projectsListQueryKey } from "~/lib/projects-query.ts";

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CreateProjectInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(PROJECT_SLUG_PATTERN, "Slug must be lowercase kebab-case"),
  organizationSlug: z.string(),
});

export function CreateProjectForm({
  onPendingChange,
}: {
  /** Fired when create submit starts/ends so a host sheet can block dismiss. */
  onPendingChange?: (pending: boolean) => void;
} = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { refresh, session } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];
  // Stays true from mutation success until this form unmounts after navigate —
  // `isPending` alone drops false before router.navigate settles, which would
  // briefly re-enable sheet dismiss and race the welcome redirect.
  const [navigatingAway, setNavigatingAway] = useState(false);
  const createProject = useMutation({
    mutationFn: async (input: { slug: string; organizationSlug: string }) => {
      const session = await connectIterateSession();
      // ONE pipelined round trip: identity() rides the create call. Create
      // resolves once the project EXISTS (identity registered, directory
      // primed, birth events appended — `readiness: "exists"`); the
      // bootstrap saga runs behind the handle, driven by create's own
      // server-side nudge, and the project home plays it from live pushes.
      const project = session.projects.get(input.slug).create(
        {
          ...(input.organizationSlug ? { organizationSlug: input.organizationSlug } : {}),
        },
        { readiness: "exists" },
      );
      // Navigate to the server's canonical slug, not the form's: auth may
      // normalize it (reserved names, all-numeric).
      const identity = await project.identity();
      return { slug: identity.slug };
    },
    onSuccess: ({ slug }) => {
      setNavigatingAway(true);
      // The project home plays bootstrap progress from live state, then
      // `welcome` hands the new owner into onboarding once ready.
      void router.navigate({
        to: "/projects/$projectSlug",
        params: { projectSlug: slug },
        search: { welcome: true },
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

  const createPending = createProject.isPending || navigatingAway;

  // Host sheet (and any other shell) must not dismiss while create is in
  // flight or while we are navigating into the new project: a mid-flight
  // close would race that navigation with a /projects bounce.
  useEffect(() => {
    onPendingChange?.(createPending);
  }, [createPending, onPendingChange]);

  return (
    <form
      className="space-y-4"
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
          <Button type="submit" disabled={!canSubmit || isSubmitting || createPending}>
            {isSubmitting || createPending ? "Creating..." : "Create project"}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
