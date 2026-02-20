import { useState, Suspense } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export const Route = createFileRoute("/_app/agents/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  component: NewAgentPage,
});

function NewAgentPage() {
  return (
    <div className="h-full p-4 md:p-6">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <NewAgentForm />
      </Suspense>
    </div>
  );
}

function normalizeAgentPath(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const withoutLeadingSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const segments = withoutLeadingSlash
    .split("/")
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);

  if (segments.length === 0) return "";
  return `/${segments.join("/")}`;
}

function NewAgentForm() {
  const navigate = useNavigate();
  const { path: initialPath } = Route.useSearch();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [path, setPath] = useState(initialPath ?? "");
  const normalizedPath = normalizeAgentPath(path);

  const createAgent = useMutation({
    mutationFn: () =>
      trpcClient.daemon.getOrCreateAgent.mutate({
        agentPath: normalizedPath,
        createWithEvents: [],
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: trpc.daemon.listAgents.queryKey() });
      navigate({
        to: "/agents/$slug",
        params: { slug: encodeURIComponent(result.agent.path) },
      });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!normalizedPath) return;
    createAgent.mutate();
  }

  const pathPreview = normalizedPath;

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 max-w-md">
      <div className="grid gap-2">
        <Label htmlFor="agent-path">Path</Label>
        <Input
          id="agent-path"
          name="agent-path"
          placeholder="/slack/thread-123"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          autoComplete="off"
          autoFocus
        />
        {path && pathPreview && path !== pathPreview && (
          <p className="text-xs text-muted-foreground">Will be saved as: {pathPreview}</p>
        )}
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={!normalizedPath || createAgent.isPending}>
          {createAgent.isPending ? "Creating..." : "Create Agent"}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate({ to: "/agents" })}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
