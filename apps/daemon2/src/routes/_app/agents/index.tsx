import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense } from "react";
import {
  PlusIcon,
  Loader2Icon,
  PlayIcon,
  SquareIcon,
  TrashIcon,
  Trash2Icon,
  BotIcon,
} from "lucide-react";

import { useTRPC } from "@/integrations/trpc/react.ts";
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
import type { AgentStatus } from "@/db/schema.ts";

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
  const clearAllMutation = useMutation(
    trpc.clearAllAgents.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      },
    }),
  );

  return (
    <div className="h-full p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-muted-foreground">
            Manage all iterate-managed coding agents on this machine
          </p>
        </div>
        <div className="flex items-center gap-2">
          {agents.length > 0 && (
            <Button
              variant="outline"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
            >
              <Trash2Icon className="size-4 mr-2" />
              Clear all
            </Button>
          )}
          <Button asChild>
            <Link to="/agents/new" search={{ name: undefined }}>
              <PlusIcon className="size-4 mr-2" />
              New Agent
            </Link>
          </Button>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="flex items-start gap-2 text-muted-foreground">
          <BotIcon className="size-4 mt-0.5" />
          <span>No agents yet. Create one to get started.</span>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Working Directory</TableHead>
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
                <TableCell>
                  <Badge variant="outline">{agent.harnessType}</Badge>
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground max-w-[300px] truncate">
                  {agent.workingDirectory}
                </TableCell>
                <TableCell>
                  <StatusBadge status={agent.status} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {agent.status === "running" ? (
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <SquareIcon className="size-4" />
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <PlayIcon className="size-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                      <TrashIcon className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
