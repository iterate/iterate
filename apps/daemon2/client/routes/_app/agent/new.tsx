import { useState, Suspense } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import type { AgentType } from "@server/db/schema.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export const Route = createFileRoute("/_app/agent/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    name: typeof search.name === "string" ? search.name : undefined,
  }),
  component: NewAgentPage,
});

const agentTypeOptions: { value: AgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
];

function NewAgentPage() {
  return (
    <div className="h-full p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">New Agent</h1>
        <p className="text-muted-foreground">Create a new coding agent session.</p>
      </div>
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function NewAgentForm() {
  const navigate = useNavigate();
  const { name: initialName } = Route.useSearch();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: serverInfo } = useSuspenseQuery(trpc.getServerCwd.queryOptions());
  const { cwd: defaultCwd, homeDir } = serverInfo;

  const [slug, setSlug] = useState(initialName ?? "");
  const [harnessType, setHarnessType] = useState<AgentType>("claude-code");
  const [workingDirectory, setWorkingDirectory] = useState(defaultCwd);

  const displayPath = (path: string) =>
    path.startsWith(homeDir) ? path.replace(homeDir, "~") : path;

  const expandPath = (path: string) => (path.startsWith("~") ? path.replace("~", homeDir) : path);

  const createAgent = useMutation({
    mutationFn: () =>
      trpcClient.createAgent.mutate({
        slug: slugify(slug),
        harnessType,
        workingDirectory,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      navigate({ to: "/agents/$slug", params: { slug: result.slug } });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim()) return;
    createAgent.mutate();
  }

  const slugPreview = slugify(slug);

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 max-w-md">
      <div className="grid gap-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input
          id="agent-name"
          name="agent-name"
          placeholder="my-feature-branch"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          autoComplete="off"
          autoFocus
        />
        {slug && slug !== slugPreview && (
          <p className="text-xs text-muted-foreground">Will be saved as: {slugPreview}</p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="harnessType">Agent Type</Label>
        <Select value={harnessType} onValueChange={(v) => setHarnessType(v as AgentType)}>
          <SelectTrigger id="harnessType">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentTypeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="workingDirectory">Working Directory</Label>
        <Input
          id="workingDirectory"
          placeholder="~/path/to/project"
          value={displayPath(workingDirectory)}
          onChange={(e) => setWorkingDirectory(expandPath(e.target.value))}
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={!slug.trim() || createAgent.isPending}>
          {createAgent.isPending ? "Creating..." : "Create Agent"}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate({ to: "/agents" })}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
