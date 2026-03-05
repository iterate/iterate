import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldGroup,
  FieldDescription,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { Button } from "@iterate-com/ui/components/button";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc, orpcClient } from "@/lib/orpc.ts";
import { createDeploymentSchema } from "@/server/db/schema.ts";

export const Route = createFileRoute("/_app/deployments/new")({
  component: NewDeployment,
});

function NewDeployment() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const form = useForm({
    defaultValues: {
      provider: "" as "docker" | "fly",
      slug: "",
      opts: "{}",
    },
    validators: {
      onChange: createDeploymentSchema,
      onSubmit: createDeploymentSchema,
    },
    onSubmit: async ({ value }) => {
      await orpcClient.deployments.create(value);
      queryClient.invalidateQueries({ queryKey: orpc.deployments.list.key() });
      navigate({ to: "/deployments/$slug", params: { slug: value.slug } });
    },
  });

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-2xl font-bold">New Deployment</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        className="space-y-6"
      >
        <FieldGroup>
          <form.Field
            name="provider"
            children={(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Provider</FieldLabel>
                  <Select
                    name={field.name}
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v as "docker" | "fly")}
                  >
                    <SelectTrigger id={field.name} aria-invalid={isInvalid}>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="docker">Docker</SelectItem>
                      <SelectItem value="fly">Fly.io</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Where this deployment will run.</FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          />

          <form.Field
            name="slug"
            children={(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Slug</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="my-deployment"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Unique identifier. Lowercase letters, numbers, and hyphens.
                  </FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          />

          <form.Field
            name="opts"
            children={(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Options (JSON)</FieldLabel>
                  <Textarea
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="{}"
                    className="min-h-[80px] font-mono text-sm"
                  />
                  <FieldDescription>Optional configuration as JSON.</FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          />
        </FieldGroup>

        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? "Creating..." : "Create Deployment"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
