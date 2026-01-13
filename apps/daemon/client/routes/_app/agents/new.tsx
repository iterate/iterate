import { useState, useEffect, Suspense } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import type { HarnessType } from "@server/db/schema.ts";
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
import { AgentTypeIcon } from "@/components/agent-type-icons.tsx";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

const adjectives = [
  "swift",
  "bright",
  "calm",
  "bold",
  "keen",
  "warm",
  "cool",
  "wild",
  "soft",
  "sharp",
  "quick",
  "quiet",
  "brave",
  "fair",
  "kind",
  "wise",
  "free",
  "pure",
  "true",
  "clear",
  "fresh",
  "light",
  "dark",
  "deep",
  "high",
  "low",
  "wide",
  "thin",
  "vast",
  "dense",
  "rare",
  "rich",
  "slim",
  "trim",
  "loud",
  "mild",
  "pale",
  "pink",
  "gold",
  "jade",
];

const nouns = [
  "fox",
  "owl",
  "oak",
  "river",
  "peak",
  "cloud",
  "stone",
  "wave",
  "leaf",
  "spark",
  "wind",
  "rain",
  "snow",
  "fire",
  "star",
  "moon",
  "sun",
  "tree",
  "lake",
  "hill",
  "bird",
  "fish",
  "bear",
  "deer",
  "wolf",
  "hawk",
  "crow",
  "frog",
  "moth",
  "swan",
  "rose",
  "fern",
  "pine",
  "elm",
  "ash",
  "bay",
  "cove",
  "glen",
  "vale",
  "ridge",
];

function generateRandomName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${num}`;
}

export const Route = createFileRoute("/_app/agents/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    name: typeof search.name === "string" ? search.name : undefined,
  }),
  component: NewAgentPage,
});

const agentTypeOptions: { value: HarnessType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
];

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
  const [harnessType, setHarnessType] = useState<HarnessType>("claude-code");
  const [workingDirectory, setWorkingDirectory] = useState(defaultCwd);

  useEffect(() => {
    if (!initialName && !slug) {
      setSlug(generateRandomName());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only run on mount or when initialName changes
  }, [initialName]);

  const displayPath = (path: string) =>
    path.startsWith(homeDir) ? path.replace(homeDir, "~") : path;

  const expandPath = (path: string) => (path.startsWith("~") ? path.replace("~", homeDir) : path);

  const createSession = useMutation({
    mutationFn: () =>
      trpcClient.createSession.mutate({
        slug: slugify(slug),
        harnessType,
        workingDirectory,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: trpc.listSessions.queryKey() });
      navigate({ to: "/agents/$slug", params: { slug: result.slug } });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim()) return;
    createSession.mutate();
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
        <Select value={harnessType} onValueChange={(v) => setHarnessType(v as HarnessType)}>
          <SelectTrigger id="harnessType">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentTypeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                <div className="flex items-center gap-2">
                  <AgentTypeIcon type={opt.value} className="size-4" />
                  {opt.label}
                </div>
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
        <Button type="submit" disabled={!slug.trim() || createSession.isPending}>
          {createSession.isPending ? "Creating..." : "Create Agent"}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate({ to: "/agents" })}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
