import { Suspense, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
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
import { parseMetadataJson } from "~/domains/secrets/metadata-json.ts";
import { useItx } from "~/itx/use-itx.ts";
import type { Stubify } from "~/itx/types.ts";
import type { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";

type SecretsCap = Stubify<Pick<SecretsCapability, "setSecret" | "listSecrets" | "deleteSecret">>;
type SecretSummary = Awaited<ReturnType<SecretsCap["listSecrets"]>>[number];

const UpdateSecretForm = z.object({
  material: z.string().min(1, "Secret material is required"),
  metadataJson: z.string().trim().min(1, "Metadata JSON is required"),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/secrets/$secretId")({
  ssr: false,
  loader: ({ context, params }) => ({
    breadcrumb: params.secretId,
    project: context.project,
  }),
  component: ProjectSecretDetailPage,
});

function ProjectSecretDetailPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectSecretDetailContent />
    </Suspense>
  );
}

function ProjectSecretDetailContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const secretsCap = itx.capability("secrets") as unknown as SecretsCap;
  const [secret, setSecret] = useState<SecretSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    secretsCap
      .listSecrets()
      .then((rows) => {
        if (cancelled) return;
        const found = rows.find((row) => row.id === params.secretId);
        if (!found) {
          toast.error(`Secret ${params.secretId} was not found for this project.`);
          return;
        }
        setSecret(found);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the itx handle identity changes (reconnect), not on every dep churn
  }, [itx, params.secretId]);

  const defaultValues = useMemo(
    () => ({
      material: "",
      metadataJson: JSON.stringify(secret?.metadata ?? {}, null, 2),
    }),
    [secret?.metadata],
  );
  const upsertSecret = useMutation({
    mutationFn: async (input: {
      key: string;
      material: string;
      metadata: Record<string, unknown>;
    }) => {
      return await secretsCap.setSecret(input);
    },
    onSuccess: async () => {
      try {
        const rows = await secretsCap.listSecrets();
        const found = rows.find((row) => row.id === params.secretId);
        if (found) setSecret(found);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      form.reset();
      toast.success("Secret updated");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const removeSecret = useMutation({
    mutationFn: async (input: { key: string }) => {
      return await secretsCap.deleteSecret(input);
    },
    onSuccess: () => {
      void navigate({
        to: "/projects/$projectSlug/secrets",
        params: {
          projectSlug: params.projectSlug,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const form = useForm({
    defaultValues,
    validators: {
      onChange: UpdateSecretForm,
      onSubmit: UpdateSecretForm,
    },
    onSubmit: async ({ value }) => {
      if (!secret) return;
      const parsed = UpdateSecretForm.parse(value);
      const metadata = parseMetadataJson(parsed.metadataJson);
      if ("message" in metadata) {
        toast.error(metadata.message);
        return;
      }

      await upsertSecret.mutateAsync({
        key: secret.key,
        material: parsed.material,
        metadata: metadata.metadata,
      });
    },
  });

  if (!secret) {
    return <div className="p-4 text-sm text-muted-foreground">Loading secret...</div>;
  }

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
              onClick={() => removeSecret.mutate({ key: secret.key })}
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
