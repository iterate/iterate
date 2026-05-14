import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { z } from "zod";
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
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc } from "~/orpc/client.ts";

const UpdateSecretForm = z.object({
  material: z.string().min(1, "Secret material is required"),
  metadataJson: z.string().trim().min(1, "Metadata JSON is required"),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/secrets/$secretId",
)({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    const secret = await context.queryClient.ensureQueryData({
      ...orpc.project.secrets.get.queryOptions({
        input: {
          id: params.secretId,
          projectSlugOrId: project.id,
        },
      }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: secret.key,
      project,
      secret,
    };
  },
  component: ProjectSecretDetailPage,
});

function ProjectSecretDetailPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project, secret: loadedSecret } = Route.useLoaderData();
  const secretQueryOptions = orpc.project.secrets.get.queryOptions({
    input: {
      id: params.secretId,
      projectSlugOrId: project.id,
    },
  });
  const secretsListQueryOptions = orpc.project.secrets.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const secretQuery = useQuery({
    ...secretQueryOptions,
    initialData: loadedSecret,
    staleTime: 10_000,
  });
  const secret = secretQuery.data;
  const defaultValues = useMemo(
    () => ({
      material: "",
      metadataJson: JSON.stringify(secret.metadata, null, 2),
    }),
    [secret.metadata],
  );
  const upsertSecret = useMutation(
    orpc.project.secrets.upsert.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: secretQueryOptions.queryKey }),
          queryClient.invalidateQueries({ queryKey: secretsListQueryOptions.queryKey }),
        ]);
        form.reset();
        toast.success("Secret updated");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const removeSecret = useMutation(
    orpc.project.secrets.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: secretsListQueryOptions.queryKey });
        void navigate({
          to: "/orgs/$organizationSlug/projects/$projectSlug/secrets",
          params: {
            organizationSlug: params.organizationSlug,
            projectSlug: params.projectSlug,
          },
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const form = useForm({
    defaultValues,
    validators: {
      onChange: UpdateSecretForm,
      onSubmit: UpdateSecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = UpdateSecretForm.parse(value);
      const metadata = parseMetadataJson(parsed.metadataJson);
      if ("message" in metadata) {
        toast.error(metadata.message);
        return;
      }

      await upsertSecret.mutateAsync({
        projectSlugOrId: project.id,
        key: secret.key,
        material: parsed.material,
        metadata: metadata.metadata,
      });
    },
  });

  return (
    <section className="w-full space-y-4 p-4">
      <div className="rounded-lg border bg-card">
        <InfoRow label="ID" value={secret.id} />
        <InfoRow label="Key" value={secret.key} />
        <InfoRow label="Material" value={secret.hasMaterial ? "Stored" : "Missing"} />
        <InfoRow label="Created" value={secret.createdAt} />
        <InfoRow label="Updated" value={secret.updatedAt} />
        <InfoRow label="Metadata" value={JSON.stringify(secret.metadata)} />
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
            <form.Field name="material">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>New value</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="password"
                      autoComplete="off"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>
                      Updating rotates the material for the existing key.
                    </FieldDescription>
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
                    <FieldDescription>
                      JSON object stored alongside the redacted Secret.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>

          <div className="flex flex-col gap-2 sm:flex-row">
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  className="self-start"
                  type="submit"
                  size="sm"
                  disabled={!canSubmit || isSubmitting || upsertSecret.isPending}
                >
                  {isSubmitting || upsertSecret.isPending ? "Updating..." : "Update Secret"}
                </Button>
              )}
            </form.Subscribe>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="self-start"
              onClick={() =>
                removeSecret.mutate({
                  id: secret.id,
                  projectSlugOrId: project.id,
                })
              }
              disabled={removeSecret.isPending}
            >
              <Trash2 className="h-4 w-4" />
              {removeSecret.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

function InfoRow(input: { label: string; value: string }) {
  return (
    <div className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[9rem_minmax(0,1fr)] md:items-center">
      <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
      <code className="min-w-0 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {input.value}
      </code>
    </div>
  );
}

function parseMetadataJson(
  value: string,
): { metadata: Record<string, unknown> } | { message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { message: "Metadata must be valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { message: "Metadata must be a JSON object." };
  }

  return { metadata: parsed as Record<string, unknown> };
}
