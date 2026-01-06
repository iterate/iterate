import * as React from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { trpc, trpcClient } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { MachineTable } from "../../../components/machine-table.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/_/$instanceSlug/")({
  component: InstanceMachinesPage,
});

function InstanceMachinesPage() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/_/$instanceSlug/" });
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [newMachineName, setNewMachineName] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);

  const { data: machines, isLoading } = useQuery(
    trpc.machine.list.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.instanceSlug,
      includeArchived: showArchived,
    }),
  );

  const { data: instance } = useQuery(
    trpc.instance.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.instanceSlug,
    }),
  );

  const createMachine = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.machine.create.mutate({
        organizationSlug: params.organizationSlug,
        instanceSlug: params.instanceSlug,
        name,
        type: "daytona",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["machine", "list"] });
      setCreateDialogOpen(false);
      setNewMachineName("");
      toast.success("Machine created!");
    },
    onError: (error) => {
      toast.error("Failed to create machine: " + error.message);
    },
  });

  const archiveMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.archive.mutate({
        organizationSlug: params.organizationSlug,
        instanceSlug: params.instanceSlug,
        machineId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["machine", "list"] });
      toast.success("Machine archived!");
    },
    onError: (error) => {
      toast.error("Failed to archive machine: " + error.message);
    },
  });

  const unarchiveMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.unarchive.mutate({
        organizationSlug: params.organizationSlug,
        instanceSlug: params.instanceSlug,
        machineId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["machine", "list"] });
      toast.success("Machine restored!");
    },
    onError: (error) => {
      toast.error("Failed to restore machine: " + error.message);
    },
  });

  const deleteMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.delete.mutate({
        organizationSlug: params.organizationSlug,
        instanceSlug: params.instanceSlug,
        machineId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["machine", "list"] });
      toast.success("Machine deleted!");
    },
    onError: (error) => {
      toast.error("Failed to delete machine: " + error.message);
    },
  });

  const handleCreateMachine = () => {
    if (newMachineName.trim()) {
      createMachine.mutate(newMachineName.trim());
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{instance?.name || "Machines"}</h1>
          <p className="text-muted-foreground">Manage your machines</p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded"
            />
            Show archived
          </label>
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Machine
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Machine</DialogTitle>
                <DialogDescription>
                  Create a new machine in this instance.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Input
                  placeholder="Machine name"
                  value={newMachineName}
                  onChange={(e) => setNewMachineName(e.target.value)}
                  disabled={createMachine.isPending}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setCreateDialogOpen(false)}
                  disabled={createMachine.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateMachine}
                  disabled={!newMachineName.trim() || createMachine.isPending}
                >
                  {createMachine.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      ) : machines && machines.length > 0 ? (
        <MachineTable
          machines={machines}
          onArchive={(id) => archiveMachine.mutate(id)}
          onUnarchive={(id) => unarchiveMachine.mutate(id)}
          onDelete={(id) => deleteMachine.mutate(id)}
        />
      ) : (
        <EmptyState
          icon={<Server className="h-12 w-12" />}
          title="No machines yet"
          description="Create your first machine to get started."
          action={{
            label: "Create Machine",
            onClick: () => setCreateDialogOpen(true),
          }}
        />
      )}
    </div>
  );
}
