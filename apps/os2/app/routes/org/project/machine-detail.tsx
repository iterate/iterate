import { useState } from "react";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Monitor,
  SquareTerminal,
  Archive,
  RotateCcw,
  Trash2,
  Copy,
  Check,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/machine/$machineId",
)({
  component: MachineDetailPage,
});

function MachineDetailPage() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/machine/$machineId",
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  const machineQueryKey = trpc.machine.byId.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    machineId: params.machineId,
  });

  const machineListQueryKey = trpc.machine.list.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const { data: machine } = useSuspenseQuery(
    trpc.machine.byId.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    }),
  );

  const archiveMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.archive.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine archived!");
      queryClient.invalidateQueries({ queryKey: machineQueryKey });
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to archive machine: " + error.message);
    },
  });

  const unarchiveMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.unarchive.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restored!");
      queryClient.invalidateQueries({ queryKey: machineQueryKey });
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to restore machine: " + error.message);
    },
  });

  const deleteMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine deleted!");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
      navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/machines",
        params: {
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        },
      });
    },
    onError: (error) => {
      toast.error("Failed to delete machine: " + error.message);
    },
  });

  const openDaemon = async () => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    });
    window.open(result.daemonUrl, "_blank");
  };

  const openTerminal = async () => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    });
    window.open(result.terminalUrl, "_blank");
  };

  const copyMachineId = async () => {
    await navigator.clipboard.writeText(machine.id);
    setCopiedId(true);
    toast.success("Machine ID copied");
    setTimeout(() => setCopiedId(false), 2000);
  };

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <div className="flex items-center gap-4">
        <Link
          to="/orgs/$organizationSlug/projects/$projectSlug/machines"
          params={{
            organizationSlug: params.organizationSlug,
            projectSlug: params.projectSlug,
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{machine.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground font-mono">{machine.id}</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyMachineId}>
              {copiedId ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={machine.state === "started" ? "success" : "secondary"}>
            {machine.state}
          </Badge>
          <Badge
            variant="outline"
            className={machine.type === "local-docker" ? "border-orange-500 text-orange-600" : ""}
          >
            {machine.type === "local-docker"
              ? `Local :${(machine.metadata as { port?: number })?.port ?? "?"}`
              : "Daytona"}
          </Badge>
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={openDaemon}>
          <Monitor className="h-4 w-4 mr-2" />
          Open Daemon
        </Button>
        {machine.type === "daytona" && (
          <Button variant="outline" onClick={openTerminal}>
            <SquareTerminal className="h-4 w-4 mr-2" />
            Terminal
          </Button>
        )}
        {machine.state === "started" ? (
          <Button
            variant="outline"
            onClick={() => archiveMachine.mutate()}
            disabled={archiveMachine.isPending}
          >
            <Archive className="h-4 w-4 mr-2" />
            Archive
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => unarchiveMachine.mutate()}
            disabled={unarchiveMachine.isPending}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Restore
          </Button>
        )}
        <Button variant="destructive" onClick={() => setDeleteConfirmOpen(true)}>
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Machine configuration and metadata</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Created</span>
              <p className="font-medium">
                {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
              </p>
            </div>
            {(machine.metadata as { snapshotName?: string })?.snapshotName && (
              <div>
                <span className="text-muted-foreground">Snapshot</span>
                <p className="font-medium font-mono text-xs">
                  {(machine.metadata as { snapshotName?: string }).snapshotName}
                </p>
              </div>
            )}
            {machine.type === "local-docker" &&
              (machine.metadata as { containerId?: string })?.containerId && (
                <div>
                  <span className="text-muted-foreground">Container ID</span>
                  <p className="font-medium font-mono text-xs">
                    {(machine.metadata as { containerId?: string }).containerId}
                  </p>
                </div>
              )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete machine?"
        description={`This will permanently delete ${machine.name}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMachine.mutate()}
        destructive
      />
    </div>
  );
}
