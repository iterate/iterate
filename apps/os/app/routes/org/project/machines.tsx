import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { MachineTable } from "../../../components/machine-table.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";
import { isNonProd } from "../../../../env-client.ts";

type MachineType = "daytona" | "local-docker" | "local";

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
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [newMachineType, setNewMachineType] = useState<MachineType>("daytona");
  const [newMachineName, setNewMachineName] = useState(`${newMachineType}-${Date.now()}`);
  const [newLocalHost, setNewLocalHost] = useState("localhost");
  const [newLocalPort, setNewLocalPort] = useState("3001");

  const machineListQueryOptions = trpc.machine.list.queryOptions({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const { data: machines } = useSuspenseQuery(machineListQueryOptions);

  const createMachine = useMutation({
    mutationFn: async ({
      name,
      type,
      metadata,
    }: {
      name: string;
      type: MachineType;
      metadata?: Record<string, unknown>;
    }) => {
      return trpcClient.machine.create.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        name,
        type,
        metadata,
      });
    },
    onSuccess: () => {
      setCreateSheetOpen(false);
      setNewMachineType("daytona");
      setNewMachineName(`daytona-${Date.now()}`);
      setNewLocalHost("localhost");
      setNewLocalPort("3001");
      toast.success("Machine created!");
      queryClient.invalidateQueries({ queryKey: machineListQueryOptions.queryKey });
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
      queryClient.invalidateQueries({ queryKey: machineListQueryOptions.queryKey });
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
      queryClient.invalidateQueries({ queryKey: machineListQueryOptions.queryKey });
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
      queryClient.invalidateQueries({ queryKey: machineListQueryOptions.queryKey });
    },
    onError: (error) => {
      toast.error("Failed to delete machine: " + error.message);
    },
  });

  const handleCreateMachine = (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = newMachineName.trim();
    if (!trimmedName) return;

    if (newMachineType === "local") {
      const host = newLocalHost.trim();
      const port = Number.parseInt(newLocalPort, 10);
      if (!host) {
        toast.error("Host is required for local machines");
        return;
      }
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        toast.error("Port must be between 1 and 65535");
        return;
      }
      createMachine.mutate({
        name: trimmedName,
        type: newMachineType,
        metadata: { host, port },
      });
      return;
    }

    createMachine.mutate({ name: trimmedName, type: newMachineType });
  };

  const createSheet = (
    <Sheet open={createSheetOpen} onOpenChange={setCreateSheetOpen}>
      <SheetContent>
        <form onSubmit={handleCreateMachine} className="flex flex-col h-full">
          <SheetHeader>
            <SheetTitle>Create Machine</SheetTitle>
            <SheetDescription>Create a new machine in this project.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-4 p-4">
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
                    <SelectItem value="local">Local (Host:Port)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {isNonProd && newMachineType === "local" && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Host</label>
                  <Input
                    placeholder="localhost"
                    value={newLocalHost}
                    onChange={(e) => setNewLocalHost(e.target.value)}
                    disabled={createMachine.isPending}
                    autoComplete="off"
                    data-1p-ignore
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Port</label>
                  <Input
                    type="number"
                    placeholder="3001"
                    min={1}
                    max={65535}
                    value={newLocalPort}
                    onChange={(e) => setNewLocalPort(e.target.value)}
                    disabled={createMachine.isPending}
                    autoComplete="off"
                    data-1p-ignore
                  />
                </div>
              </div>
            )}
          </div>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateSheetOpen(false)}
              disabled={createMachine.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!newMachineName.trim() || createMachine.isPending}>
              {createMachine.isPending ? "Creating..." : "Create"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );

  if (machines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        {createSheet}
        <EmptyState
          icon={<Server className="h-12 w-12" />}
          title="No machines yet"
          description="Create your first machine to get started."
          action={<Button onClick={() => setCreateSheetOpen(true)}>Create Machine</Button>}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <HeaderActions>
        <Button onClick={() => setCreateSheetOpen(true)} size="sm">
          <Plus className="h-4 w-4" />
          <span className="sr-only">New Machine</span>
        </Button>
      </HeaderActions>
      {createSheet}
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
