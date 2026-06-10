import { Suspense, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import type { RpcStub } from "capnweb";
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
import type { ProjectSecretSummary } from "~/domains/secrets/secrets-store.ts";
import { isItxAccessError } from "~/itx/errors.ts";
import type { Itx } from "~/itx/handle.ts";
import { useItx } from "~/itx/use-itx.ts";

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
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const [secret, setSecret] = useState<ProjectSecretSummary>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setSecret(undefined);
    setLoadError(undefined);
    itx.secrets
      .get({ id: params.secretId })
      .then((loaded) => !cancelled && setSecret(loaded))
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          isItxAccessError(error)
            ? "Secret not found."
            : error instanceof Error
              ? error.message
              : String(error),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [itx, params.secretId]);

  if (loadError) {
    return <div className="p-4 text-sm text-muted-foreground">{loadError}</div>;
  }
  if (!secret) {
    return <div className="p-4 text-sm text-muted-foreground">Loading Secret...</div>;
  }
  // Keyed remount on every update: the form re-initializes from the fresh
  // metadata and the material field clears.
  return (
    <SecretDetail key={secret.updatedAt} itx={itx} secret={secret} onSecretChange={setSecret} />
  );
}

function SecretDetail({
  itx,
  onSecretChange,
  secret,
}: {
  itx: RpcStub<Itx>;
  onSecretChange: (secret: ProjectSecretSummary) => void;
  secret: ProjectSecretSummary;
}) {
  const params = Route.useParams();
  const navigate = useNavigate();
  const [isDeleting, setIsDeleting] = useState(false);
  const form = useForm({
    defaultValues: {
      material: "",
      metadataJson: JSON.stringify(secret.metadata, null, 2),
    },
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

      try {
        const updated = await itx.secrets.upsert({
          key: secret.key,
          material: parsed.material,
          metadata: metadata.metadata,
        });
        onSecretChange(updated);
        toast.success("Secret updated");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
  });

  async function deleteSecret() {
    setIsDeleting(true);
    try {
      await itx.secrets.remove({ id: secret.id });
      void navigate({
        to: "/projects/$projectSlug/secrets",
        params: {
          projectSlug: params.projectSlug,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setIsDeleting(false);
    }
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
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? "Updating..." : "Update Secret"}
                </Button>
              )}
            </form.Subscribe>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="self-start"
              onClick={() => void deleteSecret()}
              disabled={isDeleting}
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting..." : "Delete"}
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
