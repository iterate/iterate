import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense } from "react";
import { PlusIcon, Loader2Icon, TrashIcon, BotIcon } from "lucide-react";
import { useTRPC } from "@/integrations/tanstack-query/trpc-client.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { HeaderActions } from "@/components/header-actions.tsx";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <Suspense fallback={<AgentsLoading />}>
      <AgentsContent />
    </Suspense>
  );
}

function AgentsLoading() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function AgentsContent() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: agents } = useSuspenseQuery({
    ...trpc.listAgents.queryOptions(),
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const archiveAgentMutation = useMutation(
    trpc.archiveAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      },
    }),
  );

  const formatTime = (value: string | null) => {
    if (!value) return "—";
    const date = new Date(value);
    return date.toLocaleString();
  };

  return (
    <div className="h-full p-4 md:p-6">
      <HeaderActions>
        <Button asChild size="sm">
          <Link to="/agents/new" search={{ path: undefined }}>
            <PlusIcon className="size-4" />
            <span className="sr-only">New Agent</span>
          </Link>
        </Button>
      </HeaderActions>

      {agents.length === 0 ? (
        <div className="flex items-start gap-2 text-muted-foreground">
          <BotIcon className="size-4 mt-0.5" />
          <span>No agents yet. Create one to get started.</span>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[240px]">Path</TableHead>
                <TableHead className="hidden lg:table-cell">Working Directory</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                <TableHead className="w-[60px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow
                  key={agent.path}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/agents/$slug",
                      params: { slug: encodeURIComponent(agent.path) },
                    })
                  }
                >
                  <TableCell className="font-medium">
                    <div className="truncate">{agent.path}</div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell font-mono text-sm text-muted-foreground max-w-[300px] truncate">
                    {agent.workingDirectory}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {formatTime(agent.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => archiveAgentMutation.mutate({ path: agent.path })}
                        disabled={archiveAgentMutation.isPending}
                      >
                        <TrashIcon className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
