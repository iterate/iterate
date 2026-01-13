import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense } from "react";
import { PlusIcon, Loader2Icon, PlayIcon, SquareIcon, TrashIcon, BotIcon } from "lucide-react";
import type { AgentStatus } from "@server/db/schema.ts";
import { useTRPC } from "@/integrations/tanstack-query/trpc-client.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import { AgentTypeIcon } from "@/components/agent-type-icons.tsx";
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
  const startAgentMutation = useMutation(
    trpc.startAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      },
    }),
  );

  const stopAgentMutation = useMutation(
    trpc.stopAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      },
    }),
  );

  const archiveAgentMutation = useMutation(
    trpc.archiveAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      },
    }),
  );

  return (
    <div className="h-full p-4 md:p-6">
      <HeaderActions>
        <Button asChild size="sm">
          <Link to="/agents/new" search={{ name: undefined }}>
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
                <TableHead className="w-[200px]">Name</TableHead>
                <TableHead className="hidden md:table-cell">Type</TableHead>
                <TableHead className="hidden lg:table-cell">Working Directory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow
                  key={agent.id}
                  className="cursor-pointer"
                  onClick={() => navigate({ to: "/agents/$slug", params: { slug: agent.slug } })}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <AgentTypeIcon type={agent.harnessType} className="size-4" />
                      {agent.slug}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline">{agent.harnessType}</Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell font-mono text-sm text-muted-foreground max-w-[300px] truncate">
                    {agent.workingDirectory}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={agent.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {agent.status === "running" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => stopAgentMutation.mutate({ slug: agent.slug })}
                          disabled={stopAgentMutation.isPending}
                        >
                          <SquareIcon className="size-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => startAgentMutation.mutate({ slug: agent.slug })}
                          disabled={startAgentMutation.isPending}
                        >
                          <PlayIcon className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => archiveAgentMutation.mutate({ slug: agent.slug })}
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

function StatusBadge({ status }: { status: AgentStatus }) {
  const variants: Record<AgentStatus, "default" | "secondary" | "destructive" | "outline"> = {
    running: "default",
    stopped: "secondary",
    error: "destructive",
  };

  return <Badge variant={variants[status]}>{status}</Badge>;
}
