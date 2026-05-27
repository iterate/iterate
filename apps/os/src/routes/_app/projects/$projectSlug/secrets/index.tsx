import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { parseMetadataJson } from "~/domains/secrets/metadata-json.ts";
import { orpc } from "~/orpc/client.ts";

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
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.secrets.list.queryOptions({ input: { projectSlugOrId: project.id } }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: "Secrets",
      project,
    };
  },
  component: ProjectSecretsIndexPage,
});

function ProjectSecretsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = Route.useLoaderData();
  const [filter, setFilter] = useState("");
  const secretsQueryOptions = orpc.project.secrets.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const { data } = useQuery({
    ...secretsQueryOptions,
    staleTime: 10_000,
  });
  const upsertSecret = useMutation(
    orpc.project.secrets.upsert.mutationOptions({
      onSuccess: async (secret) => {
        await queryClient.invalidateQueries({ queryKey: secretsQueryOptions.queryKey });
        form.reset();
        void navigate({
          to: "/projects/$projectSlug/secrets/$secretId",
          params: {
            projectSlug: params.projectSlug,
            secretId: secret.id,
          },
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const removeSecret = useMutation(
    orpc.project.secrets.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: secretsQueryOptions.queryKey });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
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
        projectSlugOrId: project.id,
        key: parsed.key,
        material: parsed.material,
        metadata: metadata.metadata,
      });
    },
  });

  const secrets = useMemo(() => data?.secrets ?? [], [data?.secrets]);
  const visibleSecrets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return secrets
      .filter((secret) => {
        if (!query) return true;
        return secret.key.toLowerCase().includes(query) || secret.id.toLowerCase().includes(query);
      })
      .toSorted((left, right) => left.key.localeCompare(right.key));
  }, [filter, secrets]);

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

      {secrets.length === 0 ? (
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
                  onClick={() =>
                    removeSecret.mutate({
                      id: secret.id,
                      projectSlugOrId: project.id,
                    })
                  }
                  disabled={removeSecret.isPending && removeSecret.variables?.id === secret.id}
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

function formatRelativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units = [
    { label: "year", seconds: 31_536_000 },
    { label: "month", seconds: 2_592_000 },
    { label: "day", seconds: 86_400 },
    { label: "hour", seconds: 3_600 },
    { label: "minute", seconds: 60 },
  ] as const;
  const unit = units.find((unit) => absoluteSeconds >= unit.seconds);
  if (!unit) return seconds < 0 ? "in a few seconds" : "just now";

  const count = Math.round(absoluteSeconds / unit.seconds);
  const suffix = count === 1 ? unit.label : `${unit.label}s`;
  return seconds < 0 ? `in ${count} ${suffix}` : `${count} ${suffix} ago`;
}
