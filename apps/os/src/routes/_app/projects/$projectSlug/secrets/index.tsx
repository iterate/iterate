import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
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
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { formatRelativeTime } from "~/lib/format-relative-time.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

/** Secrets live at `/secrets/<name>`; the route param is the bare name. */
const secretPathFromName = (name: string) => `/secrets/${name}`;
const secretNameFromPath = (path: string) =>
  path.startsWith("/secrets/") ? path.slice("/secrets/".length) : path;

const SecretForm = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Secret name is required")
    .regex(/^[^/]+$/, "Secret names cannot contain slashes"),
  material: z.string().min(1, "Secret material is required"),
});

const DEFAULT_SECRET_FORM_VALUES = {
  name: "",
  material: "",
};

export const Route = createFileRoute("/_app/projects/$projectSlug/secrets/")({
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "/secrets",
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
    query: (itx) => itx.secrets.list(),
  });

  const upsertSecret = useMutation({
    mutationFn: async (input: { name: string; material: string }) => {
      await itx.secrets.get(secretPathFromName(input.name)).update({ material: input.material });
      return input.name;
    },
    onSuccess: async (name) => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...secretsKey] });
      form.reset();
      void navigate({
        to: "/projects/$projectSlug/secrets/$secretId",
        params: {
          projectSlug: params.projectSlug,
          secretId: name,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  // TODO: the itx secret surface has no delete verb yet;
  // the per-row delete button returns when it does.
  const form = useForm({
    defaultValues: DEFAULT_SECRET_FORM_VALUES,
    validators: {
      onChange: SecretForm,
      onSubmit: SecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = SecretForm.parse(value);
      await upsertSecret.mutateAsync(parsed);
    },
  });

  const visibleSecrets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return secretsList
      .filter((secret) => {
        if (!query) return true;
        return secret.path.toLowerCase().includes(query);
      })
      .toSorted((left, right) => left.path.localeCompare(right.path));
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
              <form.Field name="name">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        placeholder="openai"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                      />
                      <FieldDescription>
                        Stored at <code className="text-xs">/secrets/&lt;name&gt;</code>.
                      </FieldDescription>
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
                key={secret.path}
                className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    className="flex min-w-0 items-center gap-2 text-sm font-medium hover:underline"
                    to="/projects/$projectSlug/secrets/$secretId"
                    params={{
                      projectSlug: params.projectSlug,
                      secretId: secretNameFromPath(secret.path),
                    }}
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{secretNameFromPath(secret.path)}</span>
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {secret.path} · Created {formatRelativeTime(secret.createdAt)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
