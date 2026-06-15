import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
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
import { parseMetadataJson } from "~/domains/secrets/metadata-json.ts";
import { formatRelativeTime } from "~/lib/format-relative-time.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

const SecretForm = z.object({
  key: z.string().trim().min(1, "Secret key is required"),
  material: z.string().min(1, "Secret material is required"),
  metadataJson: z.string().trim().min(1, "Metadata JSON is required"),
});

const DEFAULT_SECRET_FORM_VALUES = {
  key: "",
  material: "",
  metadataJson: "{}",
};

export const Route = createFileRoute("/_app/projects/$projectSlug/secrets/")({
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "Secrets",
    project: context.project,
  }),
  component: ProjectSecretsIndexPage,
});

function ProjectSecretsIndexPage() {
  return (
    <ItxBoundary>
      <ProjectSecretsIndexContent />
    </ItxBoundary>
  );
}

function ProjectSecretsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const secretsKey = ["secrets", project.slug];
  const secretsList = useItxQuery({
    key: secretsKey,
    query: (itx) => itx.secrets.listSecrets(),
  });

  const upsertSecret = useMutation({
    mutationFn: async (input: {
      key: string;
      material: string;
      metadata: Record<string, unknown>;
    }) => {
      return await itx.secrets.setSecret(input);
    },
    onSuccess: async (secret) => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...secretsKey] });
      form.reset();
      void navigate({
        to: "/projects/$projectSlug/secrets/$secretId",
        params: {
          projectSlug: params.projectSlug,
          secretId: secret.id,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const removeSecret = useMutation({
    mutationFn: async (input: { key: string }) => {
      return await itx.secrets.deleteSecret(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...secretsKey] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const form = useForm({
    defaultValues: DEFAULT_SECRET_FORM_VALUES,
    validators: {
      onChange: SecretForm,
      onSubmit: SecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = SecretForm.parse(value);
      const metadata = parseMetadataJson(parsed.metadataJson);
      if ("message" in metadata) {
        toast.error(metadata.message);
        return;
      }

      await upsertSecret.mutateAsync({
        key: parsed.key,
        material: parsed.material,
        metadata: metadata.metadata,
      });
    },
  });

  const visibleSecrets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (secretsList ?? [])
      .filter((secret) => {
        if (!query) return true;
        return secret.key.toLowerCase().includes(query) || secret.id.toLowerCase().includes(query);
      })
      .toSorted((left, right) => left.key.localeCompare(right.key));
  }, [filter, secretsList]);

  return (
    <section className="w-full space-y-4 p-4">
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
            <div className="grid gap-4 md:grid-cols-2">
              <form.Field name="key">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Key</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        placeholder="openai"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                      />
                      <FieldDescription>Arbitrary project-unique lookup key.</FieldDescription>
                      {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                    </Field>
                  );
                }}
              </form.Field>

              <form.Field name="material">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Value</FieldLabel>
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
                        Stored material is never returned by the API.
                      </FieldDescription>
                      {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                    </Field>
                  );
                }}
              </form.Field>
            </div>

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

          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button
                className="self-start"
                type="submit"
                size="sm"
                disabled={!canSubmit || isSubmitting || upsertSecret.isPending}
              >
                {isSubmitting || upsertSecret.isPending ? "Saving..." : "Save Secret"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>

      <div className="flex w-full flex-col gap-2 md:flex-row">
        <Input
          className="h-9 flex-1"
          placeholder="Filter secrets..."
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="md:shrink-0"
          onClick={() => setFilter("")}
        >
          Reset
        </Button>
      </div>

      {secretsList.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No Secrets</EmptyTitle>
            <EmptyDescription>
              Project Secrets will appear here after they are created.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-3">
          {visibleSecrets.length === 0 ? (
            <div className="rounded-lg border p-4 text-sm text-muted-foreground">
              No Secrets match.
            </div>
          ) : (
            visibleSecrets.map((secret) => (
              <div
                key={secret.id}
                className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    className="flex min-w-0 items-center gap-2 text-sm font-medium hover:underline"
                    to="/projects/$projectSlug/secrets/$secretId"
                    params={{
                      projectSlug: params.projectSlug,
                      secretId: secret.id,
                    }}
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{secret.key}</span>
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {secret.id} · Updated {formatRelativeTime(secret.updatedAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Delete ${secret.key}`}
                  onClick={() => removeSecret.mutate({ key: secret.key })}
                  disabled={removeSecret.isPending && removeSecret.variables?.key === secret.key}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
