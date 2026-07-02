import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

const UpdateSecretForm = z.object({
  material: z.string(),
  egressUrls: z.string(),
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
    <ItxBoundary>
      <ProjectSecretDetailContent />
    </ItxBoundary>
  );
}

function ProjectSecretDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const queryClient = useQueryClient();
  const secretPath = `/secrets/${params.secretId}`;
  const secretKey = ["secret", project.slug, secretPath];
  const secret = useItxQuery({
    key: secretKey,
    query: (itx) => itx.secrets.get(secretPath).describe(),
  });

  const updateSecret = useMutation({
    mutationFn: async (input: { material?: string; egress?: { urls: string[] } }) => {
      return await itx.secrets.get(secretPath).update(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...secretKey] });
      await queryClient.invalidateQueries({ queryKey: ["itx", "secrets", project.slug] });
      form.reset();
      toast.success("Secret updated");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  // TODO: the itx secret surface has no delete verb yet;
  // the delete button returns when it does.
  const form = useForm({
    defaultValues: {
      material: "",
      egressUrls: secret.egress.urls.join("\n"),
    },
    validators: {
      onChange: UpdateSecretForm,
      onSubmit: UpdateSecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = UpdateSecretForm.parse(value);
      const urls = parsed.egressUrls
        .split("\n")
        .map((url) => url.trim())
        .filter((url) => url !== "");
      await updateSecret.mutateAsync({
        ...(parsed.material === "" ? {} : { material: parsed.material }),
        egress: { urls },
      });
    },
  });

  return (
    <section className="w-full space-y-4 p-4">
      <div className="rounded-lg border bg-card">
        <InfoRow label="Path" value={secretPath} />
        <InfoRow label="Material" value={secret.hasMaterial ? "Stored" : "Missing"} />
        <InfoRow
          label="Egress URLs"
          value={secret.egress.urls.length > 0 ? secret.egress.urls.join(", ") : "(none)"}
        />
        <InfoRow label="Used" value={`${secret.audit.usedCount} time(s)`} />
        <InfoRow label="Last used" value={secret.audit.lastUsedAt ?? "never"} />
        <InfoRow label="Last used by" value={secret.audit.lastUsedBy ?? "(unknown)"} />
        <InfoRow label="Last used URL" value={secret.audit.lastUsedUrl ?? "(unknown)"} />
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
                      Leave blank to keep the current material; filling it rotates the material.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="egressUrls">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Egress URLs</FieldLabel>
                    <Textarea
                      id={field.name}
                      name={field.name}
                      className="min-h-24 font-mono text-xs"
                      placeholder={"https://api.example.com/*"}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>
                      One URL pattern per line. The secret can only be sent to matching egress URLs.
                    </FieldDescription>
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
                disabled={!canSubmit || isSubmitting || updateSecret.isPending}
              >
                {isSubmitting || updateSecret.isPending ? "Updating..." : "Update Secret"}
              </Button>
            )}
          </form.Subscribe>
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
