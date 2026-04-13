import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { z } from "zod";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/secrets/")({
  component: SecretsIndexPage,
});

const CreateSecretForm = z.object({
  key: z.string().trim().min(1, "Secret key is required"),
  value: z.string().min(1, "Secret value is required"),
  description: z.string(),
});

function SecretsIndexPage() {
  const queryClient = useQueryClient();
  const listSecretsQuery = useQuery({
    ...orpc.secrets.list.queryOptions({ input: { limit: 50, offset: 0 } }),
    staleTime: 30_000,
  });

  const createSecretMutation = useMutation(
    orpc.secrets.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.secrets.list.key() });
      },
    }),
  );

  const removeSecretMutation = useMutation(
    orpc.secrets.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.secrets.list.key() });
      },
    }),
  );

  const form = useForm({
    defaultValues: {
      key: "",
      value: "",
      description: "",
    },
    validators: {
      onChange: CreateSecretForm,
      onSubmit: CreateSecretForm,
    },
    onSubmit: async ({ value }) => {
      await createSecretMutation.mutateAsync({
        key: value.key.trim(),
        value: value.value,
        ...(value.description.trim() ? { description: value.description.trim() } : {}),
      });

      form.reset();
    },
  });

  return (
    <section className="max-w-md space-y-6 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">Secrets</p>
        <p className="text-sm text-muted-foreground">
          Stored in codemode&apos;s local D1 database. Use them from source headers with{" "}
          <code>getIterateSecret(&#123; secretKey: &quot;your.key&quot; &#125;)</code>.
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
          <form.Field name="key">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Secret key</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="semaphore.sharedApiSecret"
                  />
                  <FieldDescription>
                    Exact lookup key used inside <code>getIterateSecret(...)</code>.
                  </FieldDescription>
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
                  <FieldLabel htmlFor={field.name}>Secret value</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="password"
                    autoComplete="off"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="token-or-password"
                  />
                  <FieldDescription>
                    Stored now, but never returned by codemode after creation.
                  </FieldDescription>
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
                <FieldDescription>Optional human context.</FieldDescription>
              </Field>
            )}
          </form.Field>
        </FieldGroup>

        {createSecretMutation.error ? (
          <FieldError>{readErrorMessage(createSecretMutation.error)}</FieldError>
        ) : null}

        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" size="sm" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Adding..." : "Add secret"}
            </Button>
          )}
        </form.Subscribe>
      </form>

      <div className="space-y-3">
        {listSecretsQuery.data?.secrets.map((secret) => (
          <div
            key={secret.id}
            className="flex items-start justify-between gap-4 rounded-lg border p-4 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Link
                to="/secrets/$secretId"
                params={{ secretId: secret.id }}
                className="block truncate font-medium hover:underline"
              >
                {secret.key}
              </Link>
              {secret.description ? (
                <p className="text-xs text-muted-foreground">{secret.description}</p>
              ) : null}
              <Identifier value={secret.id} textClassName="text-xs text-muted-foreground" />
            </div>

            <Button
              size="sm"
              variant="destructive"
              onClick={() => removeSecretMutation.mutate({ id: secret.id })}
              disabled={
                removeSecretMutation.isPending && removeSecretMutation.variables?.id === secret.id
              }
            >
              {removeSecretMutation.isPending && removeSecretMutation.variables?.id === secret.id
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        ))}
      </div>

      {listSecretsQuery.data && listSecretsQuery.data.secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets yet. Create one above.</p>
      ) : null}
    </section>
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
