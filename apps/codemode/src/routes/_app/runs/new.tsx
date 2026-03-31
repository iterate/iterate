import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { z } from "zod";
import { runsQueryKey } from "~/lib/runs.ts";
import { orpcClient } from "~/orpc/client.ts";

const RunSnippetForm = z.object({
  code: z.string().trim().min(1, "Code is required"),
});

const DEFAULT_SNIPPET = `return [1, 2, 3].map((value) => value * 2);`;

export const Route = createFileRoute("/_app/runs/new")({
  staticData: {
    breadcrumb: "New",
  },
  component: NewRunPage,
});

function NewRunPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runMutation = useMutation({
    mutationFn: (input: { code: string }) => orpcClient.run(input),
    onError: (error) => {
      toast.error(readErrorMessage(error));
    },
  });

  const form = useForm({
    defaultValues: {
      code: DEFAULT_SNIPPET,
    },
    validators: {
      onChange: RunSnippetForm,
      onSubmit: RunSnippetForm,
    },
    onSubmit: async ({ value }) => {
      const run = await runMutation.mutateAsync({
        code: value.code.trim(),
      });

      await queryClient.invalidateQueries({ queryKey: runsQueryKey });
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });

  return (
    <section className="max-w-md space-y-6 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">New snippet</p>
        <p className="text-sm text-muted-foreground">
          Runs inside a fresh Cloudflare dynamic worker. Return a value from the snippet to save it.
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
          <form.Field name="code">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Code</FieldLabel>
                  <Textarea
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    className="min-h-52 font-mono text-sm"
                    placeholder="return 2 + 2;"
                  />
                  <FieldDescription>
                    This is treated as the body of an async function.
                  </FieldDescription>
                  {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                </Field>
              );
            }}
          </form.Field>
        </FieldGroup>

        <div className="flex gap-2">
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? "Running..." : "Run code"}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </section>
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
