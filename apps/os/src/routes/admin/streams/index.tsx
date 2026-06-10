import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamNamespace } from "@iterate-com/shared/streams/types";

export const Route = createFileRoute("/admin/streams/")({
  component: AdminStreamsNamespacePicker,
});

function AdminStreamsNamespacePicker() {
  const navigate = useNavigate();
  const [namespace, setNamespace] = useState("global");

  function submit() {
    const parsed = StreamNamespace.safeParse(namespace);
    if (!parsed.success) {
      toast.error("Namespace must be a non-empty stream namespace.");
      return;
    }

    void navigate({
      to: "/admin/streams/$namespace",
      params: { namespace: parsed.data },
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <form
        className="flex max-w-xl flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          value={namespace}
          onChange={(event) => setNamespace(event.currentTarget.value)}
          placeholder="global or project id"
          aria-label="Stream namespace"
          className="font-mono"
        />
        <Button type="submit">Open namespace</Button>
      </form>
    </section>
  );
}
