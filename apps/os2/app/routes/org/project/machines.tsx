import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { orpc, orpcClient } from "../../../lib/orpc.tsx";
import { assertProjectParams } from "../../../lib/route-params.ts";
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
import { MachineTable, type Machine } from "../../../components/machine-table.tsx";

type Project = { id: string; name: string; slug: string };

export const Route = createFileRoute(
  "/_auth-required/_/orgs/$organizationSlug/_/projects/$projectSlug/machines",
)({
  component: ProjectMachinesPage,
});

function ProjectMachinesPage() {
  const params = assertProjectParams(
    useParams({
      from: "/_auth-required/_/orgs/$organizationSlug/_/projects/$projectSlug/machines",
    }),
  );
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newMachineName, setNewMachineName] = useState("");

  const { data: machines } = useSuspenseQuery(
    orpc.machine.list.queryOptions({
      input: {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        includeArchived: false,
      },
    }),
  ) as { data: Machine[] };

  const { data: project } = useSuspenseQuery(
    orpc.project.bySlug.queryOptions({
      input: {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      },
    }),
  ) as { data: Project };

  const createMachine = useMutation({
    mutationFn: async (name: string) => {
      return orpcClient.machine.create({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        name,
        type: "daytona",
      });
    },
    onSuccess: () => {
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
      return orpcClient.machine.archive({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine archived!");
    },
    onError: (error) => {
      toast.error("Failed to archive machine: " + error.message);
    },
  });

  const unarchiveMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return orpcClient.machine.unarchive({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restored!");
    },
    onError: (error) => {
      toast.error("Failed to restore machine: " + error.message);
    },
  });

  const deleteMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return orpcClient.machine.delete({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
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
        <h1 className="text-2xl font-bold">{project?.name || "Machines"}</h1>
        <div className="flex items-center gap-4">
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
                <DialogDescription>Create a new machine in this project.</DialogDescription>
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

      {machines.length > 0 ? (
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
