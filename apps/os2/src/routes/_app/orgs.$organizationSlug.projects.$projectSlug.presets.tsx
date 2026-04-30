import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EventInput } from "@iterate-com/events-contract";
import type { ProjectPreset } from "@iterate-com/os2-contract";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/presets")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.projects.presets.list.queryOptions({ input: { projectId: project.id } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: "Presets",
    };
  },
  component: ProjectPresetsPage,
});

function ProjectPresetsPage() {
  const params = Route.useParams();
  const { data: project } = useQuery({
    ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
    staleTime: 30_000,
  });

  const { data } = useQuery({
    ...orpc.projects.presets.list.queryOptions({ input: { projectId: project?.id ?? "" } }),
    enabled: Boolean(project),
    staleTime: 30_000,
  });

  if (!project) return null;

  return <PresetEditor projectId={project.id} presets={data?.presets ?? []} />;
}

function PresetEditor({ projectId, presets }: { projectId: string; presets: ProjectPreset[] }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [eventsJson, setEventsJson] = useState("[\n]");

  const invalidatePresets = () =>
    queryClient.invalidateQueries({ queryKey: orpc.projects.presets.list.key() });

  const createPreset = useMutation(
    orpc.projects.presets.create.mutationOptions({
      onSuccess: () => {
        clearForm();
        void invalidatePresets();
        toast.success("Preset created.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const updatePreset = useMutation(
    orpc.projects.presets.update.mutationOptions({
      onSuccess: () => {
        clearForm();
        void invalidatePresets();
        toast.success("Preset saved.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const deletePreset = useMutation(
    orpc.projects.presets.remove.mutationOptions({
      onSuccess: () => {
        clearForm();
        void invalidatePresets();
        toast.success("Preset deleted.");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const clearForm = useCallback(() => {
    setEditingId(null);
    setName("");
    setDescription("");
    setEventsJson("[\n]");
  }, []);

  const loadPreset = useCallback((preset: ProjectPreset) => {
    setEditingId(preset.id);
    setName(preset.name);
    setDescription(preset.description ?? "");
    setEventsJson(JSON.stringify(preset.events, null, 2));
  }, []);

  const savePreset = useCallback(() => {
    let events: EventInput[];
    try {
      events = EventInput.array().parse(JSON.parse(eventsJson));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Events must be a JSON array.");
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Name is required.");
      return;
    }

    const payload = {
      projectId,
      name: trimmedName,
      description: description.trim() === "" ? null : description.trim(),
      events,
    };

    if (editingId) {
      updatePreset.mutate({ ...payload, id: editingId });
    } else {
      createPreset.mutate(payload);
    }
  }, [createPreset, description, editingId, eventsJson, name, projectId, updatePreset]);

  const isSaving = createPreset.isPending || updatePreset.isPending;

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Presets</h2>
        <p className="text-sm text-muted-foreground">
          Store reusable event inputs for this project's codemode sessions.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            placeholder="Preset name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            placeholder="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <Textarea
          className="min-h-56 font-mono text-xs"
          value={eventsJson}
          onChange={(event) => setEventsJson(event.target.value)}
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={savePreset} disabled={isSaving || !name.trim()}>
            {isSaving ? "Saving..." : editingId ? "Save" : "Create"}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearForm}>
            Clear
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {presets.map((preset) => (
          <div
            key={preset.id}
            className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-1">
                <p className="truncate font-medium">{preset.name}</p>
                <p className="text-sm text-muted-foreground">
                  {preset.description || `${preset.events.length} events`}
                </p>
              </div>
              <Identifier value={preset.id} textClassName="text-xs text-muted-foreground" />
              <pre className="line-clamp-4 overflow-hidden rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(preset.events, null, 2)}
              </pre>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <Button size="sm" variant="outline" onClick={() => loadPreset(preset)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => deletePreset.mutate({ id: preset.id, projectId })}
                disabled={deletePreset.isPending && deletePreset.variables?.id === preset.id}
              >
                {deletePreset.isPending && deletePreset.variables?.id === preset.id
                  ? "Deleting..."
                  : "Delete"}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {presets.length === 0 && (
        <p className="text-sm text-muted-foreground">No presets yet. Create one above.</p>
      )}
    </section>
  );
}
