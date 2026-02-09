import { useState, type FormEvent } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
  Link,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Server, Plus } from "lucide-react";
import { z } from "zod/v4";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import { MachineTable } from "../../components/machine-table.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";

type MachineType = "daytona" | "local-docker" | "local";

const DEFAULT_LOCAL_PORTS: Record<string, string> = {
  "iterate-daemon": "3000",
  "iterate-daemon-server": "3001",
  opencode: "4096",
  "jaeger-ui": "16686",
  "jaeger-otlp-http": "4318",
};
const DEFAULT_DAYTONA_SNAPSHOT_NAME = import.meta.env.VITE_DAYTONA_SNAPSHOT_NAME ?? "";

function dateSlug() {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month}-${day}-${hour}h${min}`;
}

function isDefaultMachineName(name: string) {
  return /^(daytona|local-docker|local)-[a-z]{3}-\d{1,2}-\d{2}h\d{2}$/.test(name);
}

const Search = z.object({
  create: z.boolean().optional(),
});

export const Route = createFileRoute("/_auth/proj/$projectSlug/machines")({
  validateSearch: Search,
  component: ProjectMachinesPage,
});

function ProjectMachinesPage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/machines" });
  const search = useSearch({ from: "/_auth/proj/$projectSlug/machines" });
  const matchRoute = useMatchRoute();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const machineDetailMatch = matchRoute({
    to: "/proj/$projectSlug/machines/$machineId",
    params,
  });

  const createSheetOpen = search.create === true;
  const setCreateSheetOpen = (open: boolean) => {
    navigate({ search: open ? { create: true } : {}, replace: true });
  };

  const { data: daemonData } = useSuspenseQuery(trpc.machine.getDaemonDefinitions.queryOptions());
  const { data: machineTypes } = useSuspenseQuery(
    trpc.machine.getAvailableMachineTypes.queryOptions(),
  );

  const defaultType =
    machineTypes.find((t) => !t.disabledReason)?.type ?? machineTypes[0]?.type ?? "daytona";

  const [newMachineType, setNewMachineType] = useState<MachineType>(defaultType);
  const [newMachineName, setNewMachineName] = useState(`${defaultType}-${dateSlug()}`);
  const [newLocalHost, setNewLocalHost] = useState("localhost");
  const [newLocalPorts, setNewLocalPorts] = useState<Record<string, string>>(DEFAULT_LOCAL_PORTS);
  const [newLocalDockerImage, setNewLocalDockerImage] = useState("iterate-sandbox:local");
  const [newLocalDockerSyncRepo, setNewLocalDockerSyncRepo] = useState(true);
  const [newDaytonaSnapshotName, setNewDaytonaSnapshotName] = useState(
    DEFAULT_DAYTONA_SNAPSHOT_NAME,
  );

  const machineListQueryOptions = trpc.machine.list.queryOptions({
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
      setNewLocalDockerImage("iterate-sandbox:local");
      setNewLocalDockerSyncRepo(true);
      setNewDaytonaSnapshotName(DEFAULT_DAYTONA_SNAPSHOT_NAME);
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
        projectSlug: params.projectSlug,
        machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restarting...");
    },
    onError: (error) => {
      toast.error("Failed to restart machine: " + error.message);
    },
  });

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
      createMachine.mutate({ name: trimmedName, type: newMachineType, metadata: { host, ports } });
      return;
    }

    if (newMachineType === "local-docker") {
      const imageName = newLocalDockerImage.trim();
      if (!imageName) {
        toast.error("Docker image is required");
        return;
      }
      createMachine.mutate({
        name: trimmedName,
        type: newMachineType,
        metadata: { localDocker: { imageName, syncRepo: newLocalDockerSyncRepo } },
      });
      return;
    }

    if (newMachineType === "daytona") {
      const snapshotName = newDaytonaSnapshotName.trim();
      if (!snapshotName) {
        toast.error("Snapshot name is required");
        return;
      }
      createMachine.mutate({ name: trimmedName, type: newMachineType, metadata: { snapshotName } });
      return;
    }

    createMachine.mutate({ name: trimmedName, type: newMachineType });
  };

  const createSheet = (
    <Sheet open={createSheetOpen} onOpenChange={setCreateSheetOpen}>
      <SheetContent>
        <form onSubmit={handleCreateMachine} className="flex h-full flex-col">
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
            {machineTypes.length > 1 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Machine Type</label>
                <Select
                  value={newMachineType}
                  onValueChange={(v) => {
                    const type = v as MachineType;
                    setNewMachineType(type);
                    if (isDefaultMachineName(newMachineName))
                      setNewMachineName(`${type}-${dateSlug()}`);
                  }}
                  disabled={createMachine.isPending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {machineTypes.map((mt) => (
                      <SelectItem
                        key={mt.type}
                        value={mt.type}
                        disabled={Boolean(mt.disabledReason)}
                      >
                        {mt.label}
                        {mt.disabledReason && ` (${mt.disabledReason})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {newMachineType === "daytona" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Snapshot Name</label>
                <Input
                  placeholder="iterate-sandbox-<sha>"
                  value={newDaytonaSnapshotName}
                  onChange={(e) => setNewDaytonaSnapshotName(e.target.value)}
                  disabled={createMachine.isPending}
                  autoComplete="off"
                  data-1p-ignore
                />
              </div>
            )}
            {newMachineType === "local" && (
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
            {newMachineType === "local-docker" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Docker Image</label>
                  <Input
                    placeholder="iterate-sandbox:local"
                    value={newLocalDockerImage}
                    onChange={(e) => setNewLocalDockerImage(e.target.value)}
                    disabled={createMachine.isPending}
                    autoComplete="off"
                    data-1p-ignore
                  />
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="local-docker-sync-repo"
                    checked={newLocalDockerSyncRepo}
                    onCheckedChange={(value) => setNewLocalDockerSyncRepo(value === true)}
                    disabled={createMachine.isPending}
                  />
                  <label
                    className="text-sm font-medium leading-tight"
                    htmlFor="local-docker-sync-repo"
                  >
                    Sync host git repo into the sandbox
                  </label>
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

  if (machineDetailMatch) return <Outlet />;

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

  const activeMachines = machines.filter((m) => m.state === "active");
  const previousMachines = machines.filter((m) => m.state !== "active");

  return (
    <div className="space-y-6 p-4">
      <HeaderActions>
        <Button asChild size="sm">
          <Link to={Route.fullPath} params={params} search={{ create: true }}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create Machine</span>
          </Link>
        </Button>
      </HeaderActions>
      {createSheet}
      {activeMachines.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Active Machine</h2>
            <p className="text-xs text-muted-foreground">
              This machine receives all incoming webhooks for the project.
            </p>
          </div>
          <MachineTable
            machines={activeMachines}
            projectSlug={params.projectSlug}
            onArchive={(id) => archiveMachine.mutate(id)}
            onDelete={(id) => deleteMachine.mutate(id)}
            onRestart={(id) => restartMachine.mutate(id)}
          />
        </section>
      )}
      {previousMachines.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Inactive Machines</h2>
            <p className="text-xs text-muted-foreground">
              Starting, detached, or archived machines. A new machine becomes active once it reports
              ready. Detached machines will be archived after 48 hours.
            </p>
          </div>
          <MachineTable
            machines={previousMachines}
            projectSlug={params.projectSlug}
            onArchive={(id) => archiveMachine.mutate(id)}
            onDelete={(id) => deleteMachine.mutate(id)}
            onRestart={(id) => restartMachine.mutate(id)}
          />
        </section>
      )}
    </div>
  );
}
