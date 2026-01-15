import { useState, type FormEvent } from "react";
import {
  createFileRoute,
  useParams,
  Outlet,
  useChildMatches,
  useNavigate,
  useSearch,
  Link,
} from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { z } from "zod/v4";
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

/** Default ports for daemons in local machine type */
const DEFAULT_LOCAL_PORTS: Record<string, string> = {
  "iterate-daemon": "3000",
  opencode: "4096",
};

/** Generate a readable date slug like "jan-14-15h30" */
function dateSlug() {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month}-${day}-${hour}h${min}`;
}

/** Check if name matches auto-generated pattern */
function isDefaultMachineName(name: string) {
  return /^(daytona|local-docker|local)-[a-z]{3}-\d{1,2}-\d{2}h\d{2}$/.test(name);
}

const Search = z.object({
  create: z.boolean().optional(),
});

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines",
)({
  validateSearch: Search,
  component: ProjectMachinesPage,
  beforeLoad: async ({ context, params }) => {
    // Preload data to avoid suspense - machine.list is already in parent layout
    await Promise.all([
      context.queryClient.ensureQueryData(trpc.machine.getDaemonDefinitions.queryOptions()),
      context.queryClient.ensureQueryData(
        trpc.machine.list.queryOptions({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
          includeArchived: false,
        }),
      ),
    ]);
  },
});

function ProjectMachinesPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines",
  });
  const search = useSearch({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines",
  });
  const navigate = useNavigate({ from: Route.fullPath });
  const childMatches = useChildMatches();
  const queryClient = useQueryClient();

  // Sheet open state driven by URL search param
  const createSheetOpen = search.create === true;
  const setCreateSheetOpen = (open: boolean) => {
    navigate({
      search: open ? { create: true } : {},
      replace: true,
    });
  };

  const defaultType: MachineType = "daytona";
  const [newMachineType, setNewMachineType] = useState<MachineType>(defaultType);
  const [newMachineName, setNewMachineName] = useState(`${defaultType}-${dateSlug()}`);
  const [newLocalHost, setNewLocalHost] = useState("localhost");
  // Per-daemon port state for local machines (daemonId -> port string)
  const [newLocalPorts, setNewLocalPorts] = useState<Record<string, string>>(DEFAULT_LOCAL_PORTS);

  // Fetch daemon definitions for the form
  const { data: daemonData } = useSuspenseQuery(trpc.machine.getDaemonDefinitions.queryOptions());

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
      setNewMachineType(defaultType);
      setNewMachineName(`${defaultType}-${dateSlug()}`);
      setNewLocalHost("localhost");
      setNewLocalPorts(DEFAULT_LOCAL_PORTS);
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

  const restartMachine = useMutation({
    mutationFn: async (machineId: string) => {
      return trpcClient.machine.restart.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restarting...");
      // Don't refetch - the backend broadcasts invalidation which triggers realtime update
    },
    onError: (error) => {
      toast.error("Failed to restart machine: " + error.message);
    },
  });

  // If there's a child route (e.g., machine detail), render it instead
  if (childMatches.length > 0) {
    return <Outlet />;
  }

  const handleCreateMachine = (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = newMachineName.trim();
    if (!trimmedName) return;

    if (newMachineType === "local") {
      const host = newLocalHost.trim();
      if (!host) {
        toast.error("Host is required for local machines");
        return;
      }
      // Validate all daemon ports
      const ports: Record<string, number> = {};
      for (const daemon of daemonData.daemons) {
        const portStr = newLocalPorts[daemon.id] ?? "";
        const port = Number.parseInt(portStr, 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          toast.error(`Port for ${daemon.name} must be between 1 and 65535`);
          return;
        }
        ports[daemon.id] = port;
      }
      createMachine.mutate({
        name: trimmedName,
        type: newMachineType,
        metadata: { host, ports },
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
                    // Only auto-generate name if it looks like a default name
                    if (isDefaultMachineName(newMachineName)) {
                      setNewMachineName(`${type}-${dateSlug()}`);
                    }
                  }}
                  disabled={createMachine.isPending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local-docker">Local Docker</SelectItem>
                    <SelectItem value="daytona">Daytona (Cloud)</SelectItem>
                    <SelectItem value="local">Local (Host:Port)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {isNonProd && newMachineType === "local" && (
              <div className="space-y-4">
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
                  <label className="text-sm font-medium">Daemon Ports</label>
                  <div className="grid grid-cols-2 gap-3">
                    {daemonData.daemons.map((daemon) => (
                      <div key={daemon.id} className="space-y-1">
                        <label className="text-xs text-muted-foreground">{daemon.name}</label>
                        <Input
                          type="number"
                          placeholder={String(daemon.internalPort)}
                          min={1}
                          max={65535}
                          value={newLocalPorts[daemon.id] ?? ""}
                          onChange={(e) =>
                            setNewLocalPorts((prev) => ({ ...prev, [daemon.id]: e.target.value }))
                          }
                          disabled={createMachine.isPending}
                          autoComplete="off"
                          data-1p-ignore
                        />
                      </div>
                    ))}
                  </div>
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
          action={
            <Button asChild>
              <Link to={Route.fullPath} params={params} search={{ create: true }}>
                Create Machine
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      <HeaderActions>
        <Button asChild size="sm">
          <Link to={Route.fullPath} params={params} search={{ create: true }}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create Machine</span>
          </Link>
        </Button>
      </HeaderActions>
      {createSheet}
      <MachineTable
        machines={machines}
        organizationSlug={params.organizationSlug}
        projectSlug={params.projectSlug}
        onArchive={(id) => archiveMachine.mutate(id)}
        onDelete={(id) => deleteMachine.mutate(id)}
        onRestart={(id) => restartMachine.mutate(id)}
      />
    </div>
  );
}
