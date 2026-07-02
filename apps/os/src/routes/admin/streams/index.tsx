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
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";

export const Route = createFileRoute("/admin/streams/")({
  component: AdminStreamsProjectPicker,
});

function AdminStreamsProjectPicker() {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(NULL_DURABLE_OBJECT_PROJECT_ID);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsed = projectId.trim();
    if (parsed.length === 0) {
      setError("Project id is required.");
      toast.error("Project id is required.");
      return;
    }
    setError(null);

    void navigate({
      to: "/admin/streams/$projectId",
      params: { projectId: parsed },
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold">Streams explorer</h1>
        <p className="text-sm text-muted-foreground">
          Open streams by project id. Use __null__ for deployment-wide streams.
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
            <FieldLabel htmlFor="admin-stream-project-id">Project ID</FieldLabel>
            <Input
              id="admin-stream-project-id"
              value={projectId}
              onChange={(event) => setProjectId(event.currentTarget.value)}
              placeholder="__null__ or prj_..."
              aria-invalid={error != null}
              className="font-mono"
            />
            <FieldDescription>Use a project id to inspect that project's streams.</FieldDescription>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
        <Button type="submit" className="self-start">
          Open project
          <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </form>
    </section>
  );
}
