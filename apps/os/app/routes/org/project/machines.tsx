import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { MachineTable } from "../../../components/machine-table.tsx";
import { isNonProd } from "../../../../env-client.ts";

type MachineType = "daytona" | "local-docker";

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines",
)({
  component: ProjectMachinesPage,
});

function ProjectMachinesPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines",
  });
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newMachineType, setNewMachineType] = useState<MachineType>("daytona");
  const [newMachineName, setNewMachineName] = useState(`${newMachineType}-${Date.now()}`);

  const machineListQueryKey = trpc.machine.list.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  const createMachine = useMutation({
    mutationFn: async ({ name, type }: { name: string; type: MachineType }) => {
      return trpcClient.machine.create.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        name,
        type,
      });
    },
    onSuccess: () => {
      setCreateDialogOpen(false);
      setNewMachineType("daytona");
      setNewMachineName(`daytona-${Date.now()}`);
      toast.success("Machine created!");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to create machine: " + error.message);
    },
  });

  const archiveMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.archive.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine archived!");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to archive machine: " + error.message);
    },
  });

  const unarchiveMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.unarchive.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restored!");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to restore machine: " + error.message);
    },
  });

  const deleteMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine deleted!");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to delete machine: " + error.message);
    },
  });

  const handleCreateMachine = (e: FormEvent) => {
    e.preventDefault();
    if (newMachineName.trim()) {
      createMachine.mutate({ name: newMachineName.trim(), type: newMachineType });
    }
  };

  const createDialog = (
    <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
      <DialogContent>
        <form onSubmit={handleCreateMachine}>
          <DialogHeader>
            <DialogTitle>Create Machine</DialogTitle>
            <DialogDescription>Create a new machine in this project.</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="Machine name"
                value={newMachineName}
                onChange={(e) => setNewMachineName(e.target.value)}
                disabled={createMachine.isPending}
                autoFocus
                autoComplete="off"
                data-1p-ignore
              />
            </div>
            {isNonProd && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Machine Type</label>
                <Select
                  value={newMachineType}
                  onValueChange={(v) => {
                    const type = v as MachineType;
                    setNewMachineType(type);
                    setNewMachineName(`${type}-${Date.now()}`);
                  }}
                  disabled={createMachine.isPending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daytona">Daytona (Cloud)</SelectItem>
                    <SelectItem value="local-docker">Local Docker</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={createMachine.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!newMachineName.trim() || createMachine.isPending}>
              {createMachine.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  if (machines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        {createDialog}
        <EmptyState
          icon={<Server className="h-12 w-12" />}
          title="No machines yet"
          description="Create your first machine to get started."
          action={<Button onClick={() => setCreateDialogOpen(true)}>Create Machine</Button>}
        />
      </div>
    );
  }

  return (
    <div className="p-8">
      {createDialog}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Machines</h1>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Machine
        </Button>
      </div>
      <MachineTable
        machines={machines}
        organizationSlug={params.organizationSlug}
        projectSlug={params.projectSlug}
        onArchive={(id) => archiveMachine.mutate(id)}
        onUnarchive={(id) => unarchiveMachine.mutate(id)}
        onDelete={(id) => deleteMachine.mutate(id)}
      />
    </div>
  );
}
