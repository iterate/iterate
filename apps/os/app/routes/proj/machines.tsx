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
import { Input } from "../../components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import { MachineTable } from "../../components/machine-table.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";

/** Metadata key used by each provider to override the default image/snapshot */
const SNAPSHOT_META: Record<string, { key: string; label: string; placeholder: string }> = {
  daytona: {
    key: "snapshotName",
    label: "Snapshot",
    placeholder: "iterate-sandbox-sha-<shortSha> (leave blank for default)",
  },
  fly: {
    key: "snapshotName",
    label: "Image",
    placeholder: "registry.fly.io/iterate-sandbox-image:sha-<shortSha> (leave blank for default)",
  },
  docker: {
    key: "localDocker.imageName",
    label: "Image",
    placeholder: "iterate-sandbox:sha-<shortSha> (leave blank for default)",
  },
};

function dateSlug() {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month}-${day}-${hour}h${min}`;
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

  const { data: project } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      projectSlug: params.projectSlug,
    }),
  );
  const sandboxProvider = project.sandboxProvider;

  const { data: defaultSnapshots } = useSuspenseQuery(
    trpc.machine.getDefaultSnapshots.queryOptions({}),
  );
  const defaultSnapshotForProvider =
    defaultSnapshots[sandboxProvider as keyof typeof defaultSnapshots] ?? "";

  const [newMachineName, setNewMachineName] = useState(`${sandboxProvider}-${dateSlug()}`);
  const [snapshotOverride, setSnapshotOverride] = useState(defaultSnapshotForProvider);

  const machineListQueryOptions = trpc.machine.list.queryOptions({
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const { data: machines } = useSuspenseQuery(machineListQueryOptions);

  const createMachine = useMutation({
    mutationFn: async ({
      name,
      metadata,
    }: {
      name: string;
      metadata?: Record<string, unknown>;
    }) => {
      return trpcClient.machine.create.mutate({
        projectSlug: params.projectSlug,
        name,
        metadata,
      });
    },
    onSuccess: () => {
      setCreateSheetOpen(false);
      setNewMachineName(`${sandboxProvider}-${dateSlug()}`);
      setSnapshotOverride(sandboxProvider === "daytona" ? DEFAULT_DAYTONA_SNAPSHOT_NAME : "");
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

    const snapshot = snapshotOverride.trim();
    const meta = SNAPSHOT_META[sandboxProvider];

    // Build metadata from the snapshot override
    let metadata: Record<string, unknown> | undefined;
    if (snapshot && meta) {
      if (meta.key.includes(".")) {
        // Nested key like "localDocker.imageName"
        const [parent, child] = meta.key.split(".");
        metadata = { [parent]: { [child]: snapshot } };
      } else {
        metadata = { [meta.key]: snapshot };
      }
    }

    createMachine.mutate({ name: trimmedName, metadata });
  };

  const createSheet = (
    <Sheet open={createSheetOpen} onOpenChange={setCreateSheetOpen}>
      <SheetContent>
        <form onSubmit={handleCreateMachine} className="flex h-full flex-col">
          <SheetHeader>
            <SheetTitle>Create Machine</SheetTitle>
            <SheetDescription>
              Create a new machine in this project. Provider is managed at project level.
            </SheetDescription>
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
            <div className="space-y-1">
              <div className="text-sm font-medium">Sandbox Provider</div>
              <div className="text-sm text-muted-foreground">{sandboxProvider}</div>
            </div>
            {SNAPSHOT_META[sandboxProvider] && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {SNAPSHOT_META[sandboxProvider].label}
                </label>
                <Input
                  placeholder={SNAPSHOT_META[sandboxProvider].placeholder}
                  value={snapshotOverride}
                  onChange={(e) => setSnapshotOverride(e.target.value)}
                  disabled={createMachine.isPending}
                  autoComplete="off"
                  data-1p-ignore
                />
                <p className="text-xs text-muted-foreground">
                  Override the default {SNAPSHOT_META[sandboxProvider].label.toLowerCase()}. Leave
                  blank to use the Doppler default.
                </p>
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
