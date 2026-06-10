import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
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
import { StreamNamespace } from "@iterate-com/shared/streams/types";

export const Route = createFileRoute("/admin/streams/")({
  component: AdminStreamsNamespacePicker,
});

function AdminStreamsNamespacePicker() {
  const navigate = useNavigate();
  const [namespace, setNamespace] = useState("global");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsed = StreamNamespace.safeParse(namespace);
    if (!parsed.success) {
      setError("Namespace must be a non-empty stream namespace.");
      toast.error("Namespace must be a non-empty stream namespace.");
      return;
    }
    setError(null);

    void navigate({
      to: "/admin/streams/$namespace",
      params: { namespace: parsed.data },
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">Streams explorer</h1>
        <p className="text-sm text-muted-foreground">
          Open any stream namespace by namespace id, including project ids.
        </p>
      </div>
      <form
        className="flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FieldGroup>
          <Field data-invalid={error != null}>
            <FieldLabel htmlFor="admin-stream-namespace">Namespace</FieldLabel>
            <Input
              id="admin-stream-namespace"
              value={namespace}
              onChange={(event) => setNamespace(event.currentTarget.value)}
              placeholder="global or prj_..."
              aria-invalid={error != null}
              className="font-mono"
            />
            <FieldDescription>Use a project id to inspect that project's streams.</FieldDescription>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
        <Button type="submit" className="self-start">
          Open namespace
          <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </form>
    </section>
  );
}
