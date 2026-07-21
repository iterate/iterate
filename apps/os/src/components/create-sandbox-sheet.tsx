import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Switch } from "@iterate-com/ui/components/switch";
import { useItx } from "iterate/react";
import {
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  SANDBOX_INSTANCE_TYPES,
  SandboxInstanceType,
  type SandboxInstanceType as SandboxInstanceTypeValue,
} from "~/domains/sandboxes/instance-types.ts";
import {
  DEFAULT_SANDBOX_CREATE_FORM_VALUES,
  DEFAULT_SANDBOX_SLEEP_AFTER,
  parseSandboxCreateForm,
  SandboxCreateFormSchema,
  shouldApplySandboxSheetOpenChange,
  type SandboxCreateFormValues,
} from "~/lib/sandbox-create-form.ts";

const INSTANCE_TYPE_DETAILS: Record<SandboxInstanceTypeValue, string> = {
  lite: "1/16 vCPU · 256 MiB · 2 GB disk",
  basic: "1/4 vCPU · 1 GiB · 4 GB disk",
  "standard-1": "1/2 vCPU · 4 GiB · 8 GB disk",
  "standard-2": "1 vCPU · 6 GiB · 12 GB disk",
  "standard-3": "2 vCPU · 8 GiB · 16 GB disk",
  "standard-4": "4 vCPU · 12 GiB · 20 GB disk",
};

const INSTANCE_TYPE_ITEMS = SANDBOX_INSTANCE_TYPES.map((value) => ({
  label: value,
  value,
}));

export function CreateSandboxSheet({
  onCreated,
  onOpenChange,
  open,
}: {
  onCreated: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const itx = useItx();
  const createSandbox = useMutation({
    mutationFn: async (values: SandboxCreateFormValues) => {
      const parsed = parseSandboxCreateForm(values);
      await itx.sandboxes.get(parsed.path).create(parsed.input);
      return parsed.path;
    },
    onSuccess: (path) => {
      form.reset();
      onOpenChange(false);
      toast.success(`Created ${path}`);
      onCreated(path);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const form = useForm({
    defaultValues: DEFAULT_SANDBOX_CREATE_FORM_VALUES,
    validators: {
      onChange: SandboxCreateFormSchema,
      onSubmit: SandboxCreateFormSchema,
    },
    onSubmit: async ({ value }) => createSandbox.mutateAsync(value),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!shouldApplySandboxSheetOpenChange(nextOpen, createSandbox.isPending)) return;
        onOpenChange(nextOpen);
        if (!nextOpen) form.reset();
      }}
    >
      <SheetContent
        side="right"
        className="overflow-y-auto"
        showCloseButton={!createSandbox.isPending}
      >
        <form
          className="flex h-full flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <SheetHeader>
            <SheetTitle>Create sandbox</SheetTitle>
            <SheetDescription>
              Create an isolated Linux container whose workspace survives stops and restarts.
            </SheetDescription>
          </SheetHeader>

          <FieldGroup className="flex-1 p-4">
            <form.Field name="name">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      placeholder="development"
                      autoComplete="off"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>
                      A single path segment. The sandbox will live at{" "}
                      <code className="text-xs">/sandboxes/&lt;name&gt;</code>.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="instanceType">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Instance type</FieldLabel>
                    <Select
                      items={INSTANCE_TYPE_ITEMS}
                      value={field.state.value}
                      onValueChange={(value) =>
                        field.handleChange(
                          SandboxInstanceType.parse(value ?? DEFAULT_SANDBOX_INSTANCE_TYPE),
                        )
                      }
                    >
                      <SelectTrigger id={field.name} className="w-full" aria-invalid={isInvalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {INSTANCE_TYPE_ITEMS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {INSTANCE_TYPE_DETAILS[field.state.value]} · Fixed for this sandbox&apos;s
                      lifetime.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.keepAlive}>
              {(keepAlive) => (
                <form.Field name="sleepAfter">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-disabled={keepAlive} data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Sleep after</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          placeholder={DEFAULT_SANDBOX_SLEEP_AFTER}
                          disabled={keepAlive}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                          aria-invalid={isInvalid}
                        />
                        <FieldDescription>
                          {keepAlive
                            ? "Disabled while keep alive is enabled."
                            : 'Idle duration such as "30s", "5m", or "1h".'}
                        </FieldDescription>
                        {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                      </Field>
                    );
                  }}
                </form.Field>
              )}
            </form.Subscribe>

            <form.Field name="keepAlive">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Keep alive</FieldTitle>
                    <FieldDescription>
                      Keep the container running until it is stopped or destroyed explicitly.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    aria-label="Keep alive"
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                  />
                </Field>
              )}
            </form.Field>
          </FieldGroup>

          <SheetFooter className="border-t sm:flex-row sm:justify-end">
            <SheetClose
              disabled={createSandbox.isPending}
              render={<Button type="button" variant="outline" />}
            >
              Cancel
            </SheetClose>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => {
                const pending = isSubmitting || createSandbox.isPending;
                return (
                  <Button type="submit" disabled={!canSubmit || pending}>
                    {pending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <PlusIcon data-icon="inline-start" />
                    )}
                    Create sandbox
                  </Button>
                );
              }}
            </form.Subscribe>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
