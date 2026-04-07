import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { z } from "zod";
import { getOrpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/secrets/")({
  component: SecretsIndexPage,
});

const CreateSecretForm = z.object({
  name: z.string().trim().min(1, "Name is required"),
  value: z.string().min(1, "Value is required"),
  description: z.string(),
});

function SecretsIndexPage() {
  const queryClient = useQueryClient();
  const orpc = getOrpc();
  const { data: secretsData } = useQuery({
    ...orpc.secrets.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

  const createSecret = useMutation(
    orpc.secrets.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.secrets.list.key() });
      },
    }),
  );

  const deleteSecret = useMutation(
    orpc.secrets.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.secrets.list.key() });
      },
    }),
  );

  // TanStack Form pattern:
  // https://tanstack.com/form/latest/docs/framework/react/guides/basic-concepts
  // Local example: apps/example/src/routes/_app/log-stream.tsx
  const form = useForm({
    defaultValues: {
      name: "",
      value: "",
      description: "",
    },
    validators: {
      onChange: CreateSecretForm,
      onSubmit: CreateSecretForm,
    },
    onSubmit: async ({ value }) => {
      await createSecret.mutateAsync({
        name: value.name.trim(),
        value: value.value,
        ...(value.description.trim() ? { description: value.description.trim() } : {}),
      });

      form.reset();
    },
  });

  return (
    <section className="max-w-md space-y-6 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Env vars</h2>
        <p className="text-sm text-muted-foreground">
          Environment variables for this project. Values are masked in the UI and stored in
          plaintext in D1 for this demo.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="name">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="GITHUB_ACCESS_TOKEN"
                  />
                  <FieldDescription>Unique environment variable name.</FieldDescription>
                  {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="value">
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
                    placeholder="ghp_..."
                  />
                  <FieldDescription>Stored, but never shown again in this UI.</FieldDescription>
                  {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Optional note"
                />
                <FieldDescription>Optional context for humans.</FieldDescription>
              </Field>
            )}
          </form.Field>
        </FieldGroup>

        {createSecret.error ? (
          <FieldError>{readErrorMessage(createSecret.error)}</FieldError>
        ) : null}

        <div className="flex gap-2">
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button type="submit" size="sm" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? "Adding..." : "Add env var"}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>

      <div className="space-y-3">
        {secretsData?.secrets.map((secret) => (
          <div
            key={secret.id}
            className="flex items-start justify-between gap-4 rounded-lg border p-4 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate font-mono text-sm font-medium">{secret.name}=****</p>
              {secret.description ? (
                <p className="text-xs text-muted-foreground">{secret.description}</p>
              ) : null}
            </div>

            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteSecret.mutate({ id: secret.id })}
              disabled={deleteSecret.isPending && deleteSecret.variables?.id === secret.id}
            >
              {deleteSecret.isPending && deleteSecret.variables?.id === secret.id
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        ))}
      </div>

      {secretsData && secretsData.secrets.length === 0 && (
        <p className="text-sm text-muted-foreground">No env vars yet. Create one above.</p>
      )}
    </section>
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
