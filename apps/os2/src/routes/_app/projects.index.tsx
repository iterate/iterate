import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/")({
  component: ProjectsIndexPage,
});

function formatMetadata(metadata: Record<string, unknown>) {
  return JSON.stringify(metadata);
}

function ProjectsIndexPage() {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [metadataJson, setMetadataJson] = useState('{\n  "owner": "os"\n}');
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const { data: projectsData } = useQuery({
    ...orpc.projects.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: () => {
        setSlug("");
        setMetadataJson('{\n  "owner": "os"\n}');
        setMetadataError(null);
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
      },
    }),
  );

  const deleteProject = useMutation(
    orpc.projects.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
      },
    }),
  );

  const handleCreate = useCallback(() => {
    const projectSlug = slug.trim();
    if (!projectSlug) return;

    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(metadataJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMetadataError("Metadata must be a JSON object.");
        return;
      }
      metadata = parsed as Record<string, unknown>;
    } catch {
      setMetadataError("Metadata must be valid JSON.");
      return;
    }

    setMetadataError(null);
    createProject.mutate({ slug: projectSlug, metadata });
  }, [createProject, metadataJson, slug]);

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Projects</h2>
        <p className="text-sm text-muted-foreground">
          CRUD backed by sqlfu + D1, with type IDs and JSON metadata.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-start">
          <Input
            placeholder="project-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleCreate()}
          />
          <Textarea
            className="min-h-24 font-mono text-xs"
            value={metadataJson}
            onChange={(event) => setMetadataJson(event.target.value)}
          />
          <Button
            size="sm"
            disabled={createProject.isPending || !slug.trim()}
            onClick={handleCreate}
          >
            {createProject.isPending ? "Adding..." : "Add"}
          </Button>
        </div>
        {metadataError && <p className="text-sm text-destructive">{metadataError}</p>}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <div className="grid min-w-[920px] grid-cols-[220px_160px_minmax(220px,1fr)_190px_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
          <div>ID</div>
          <div>Slug</div>
          <div>Metadata</div>
          <div>Created</div>
          <div>Updated</div>
          <div />
        </div>
        {projectsData?.projects.map((project) => (
          <div
            key={project.id}
            className="grid min-w-[920px] grid-cols-[220px_160px_minmax(220px,1fr)_190px_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
          >
            <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="truncate font-medium hover:underline"
            >
              {project.slug}
            </Link>
            <code className="line-clamp-3 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {formatMetadata(project.metadata)}
            </code>
            <div className="text-xs text-muted-foreground">{project.createdAt}</div>
            <div className="text-xs text-muted-foreground">{project.updatedAt}</div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteProject.mutate({ id: project.id })}
              disabled={deleteProject.isPending && deleteProject.variables?.id === project.id}
            >
              {deleteProject.isPending && deleteProject.variables?.id === project.id
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        ))}
      </div>

      {projectsData && projectsData.projects.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects yet. Create one above.</p>
      )}
    </section>
  );
}
