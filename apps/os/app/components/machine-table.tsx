import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import {
  MoreHorizontal,
  Archive,
  Trash2,
  RotateCcw,
  Monitor,
  ScrollText,
  SquareTerminal,
  Terminal,
  RefreshCw,
  Activity,
  Circle,
} from "lucide-react";
import { toast } from "sonner";
import { trpcClient } from "../lib/trpc.tsx";
import { TypeId } from "./type-id.tsx";
import { Button } from "./ui/button.tsx";
import { ConfirmDialog } from "./ui/confirm-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

interface Machine {
  id: string;
  name: string;
  type: string;
  state: "started" | "archived";
  createdAt: Date;
  metadata: { snapshotName?: string; containerId?: string; port?: number } & Record<
    string,
    unknown
  >;
}

interface MachineTableProps {
  machines: Machine[];
  organizationSlug: string;
  projectSlug: string;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  isLoading?: boolean;
}

export function MachineTable({
  machines,
  organizationSlug,
  projectSlug,
  onArchive,
  onUnarchive,
  onDelete,
  isLoading,
}: MachineTableProps) {
  const [deleteConfirmMachine, setDeleteConfirmMachine] = useState<Machine | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">Loading machines...</div>
      </div>
    );
  }

  if (machines.length === 0) {
    return null;
  }

  // === Open URL helpers ===

  const openDaemonProxy = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    window.open(result.daemonUrl, "_blank");
  };

  const openTerminalProxy = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    window.open(result.terminalUrl, "_blank");
  };

  const openDaemonNative = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    if (result.nativeDaemonUrl) {
      window.open(result.nativeDaemonUrl, "_blank");
    } else {
      toast.error("Native URL not available" + JSON.stringify(result));
    }
  };

  const openTerminalNative = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    if (result.nativeTerminalUrl) {
      window.open(result.nativeTerminalUrl, "_blank");
    } else {
      toast.error("Native terminal URL not available");
    }
  };

  // === Copy command helpers ===

  const copyToClipboard = async (command: string, description: string, hint?: string) => {
    await navigator.clipboard.writeText(command);
    toast.success(
      <div className="space-y-1">
        <div>{description}</div>
        <code className="block text-xs font-mono bg-black/10 dark:bg-white/10 px-2 py-1.5 rounded border border-black/10 dark:border-white/10">
          {command}
        </code>
        {hint && <div className="text-xs text-muted-foreground mt-2">{hint}</div>}
      </div>,
    );
  };

  const copyTerminalCommand = (machine: Machine) => {
    const containerId = machine.metadata.containerId;
    if (!containerId) {
      toast.error("Container ID not found");
      return;
    }
    copyToClipboard(
      `docker exec -it ${containerId} /bin/bash`,
      "Copied terminal command:",
      "Run this in your local terminal",
    );
  };

  const copyDaemonLogsCommand = (machine: Machine) => {
    const command = "tail -f /var/log/iterate-daemon/current";
    if (machine.type === "local-docker") {
      const containerId = machine.metadata.containerId;
      if (!containerId) {
        toast.error("Container ID not found");
        return;
      }
      copyToClipboard(
        `docker exec ${containerId} ${command}`,
        "Copied daemon logs command:",
        "Run in your local terminal. Won't work until entry.ts starts daemons.",
      );
    } else {
      copyToClipboard(command, "Copied daemon logs command:", "Paste this in the sandbox terminal");
    }
  };

  const copyEntryLogsCommand = (machine: Machine) => {
    if (machine.type === "local-docker") {
      const containerId = machine.metadata.containerId;
      if (!containerId) {
        toast.error("Container ID not found");
        return;
      }
      copyToClipboard(
        `docker logs -f ${containerId}`,
        "Copied entry.ts logs command:",
        "Run in your local terminal",
      );
    } else {
      toast.info("Entry logs for Daytona machines go to container stdout");
    }
  };

  const copyServiceStatusCommand = (machine: Machine) => {
    const command =
      'export S6DIR=/root/src/github.com/iterate/iterate/s6-daemons && for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done';
    if (machine.type === "local-docker") {
      const containerId = machine.metadata.containerId;
      if (!containerId) {
        toast.error("Container ID not found");
        return;
      }
      copyToClipboard(
        `docker exec ${containerId} sh -c '${command}'`,
        "Copied service status command:",
        "Run in your local terminal to see s6 service status",
      );
    } else {
      copyToClipboard(
        command,
        "Copied service status command:",
        "Paste in the sandbox terminal to check s6 service status",
      );
    }
  };

  // === Actions ===

  const restartMachine = async (machineId: string) => {
    try {
      await trpcClient.machine.restart.mutate({
        organizationSlug,
        projectSlug,
        machineId,
      });
      toast.success("Machine restarting...");
    } catch (err) {
      toast.error(`Failed to restart: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // === Dropdown menu (shared between layouts) ===
  const renderDropdownContent = (machine: Machine) => (
    <DropdownMenuContent align="end" className="w-56">
      {machine.type === "daytona" && (
        <>
          <DropdownMenuItem onClick={() => openTerminalNative(machine.id)}>
            <SquareTerminal className="h-4 w-4 mr-2" />
            Terminal (Daytona native)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openTerminalProxy(machine.id)}>
            <SquareTerminal className="h-4 w-4 mr-2" />
            Terminal (Iterate proxy)
          </DropdownMenuItem>
        </>
      )}
      {machine.type === "local-docker" && (
        <DropdownMenuItem onClick={() => copyTerminalCommand(machine)}>
          <Terminal className="h-4 w-4 mr-2" />
          Copy terminal command
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      {machine.type === "daytona" && (
        <>
          <DropdownMenuItem onClick={() => openDaemonNative(machine.id)}>
            <Monitor className="h-4 w-4 mr-2" />
            Daemon (Daytona native)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDaemonProxy(machine.id)}>
            <Monitor className="h-4 w-4 mr-2" />
            Daemon (Iterate proxy)
          </DropdownMenuItem>
        </>
      )}
      {machine.type === "local-docker" && (
        <>
          <DropdownMenuItem onClick={() => openDaemonNative(machine.id)}>
            <Monitor className="h-4 w-4 mr-2" />
            Daemon (localhost)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDaemonProxy(machine.id)}>
            <Monitor className="h-4 w-4 mr-2" />
            Daemon (Iterate proxy)
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => copyDaemonLogsCommand(machine)}>
        <ScrollText className="h-4 w-4 mr-2" />
        Copy daemon logs command
      </DropdownMenuItem>
      {machine.type === "local-docker" && (
        <DropdownMenuItem onClick={() => copyEntryLogsCommand(machine)}>
          <ScrollText className="h-4 w-4 mr-2" />
          Copy entry.ts logs command
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={() => copyServiceStatusCommand(machine)}>
        <Activity className="h-4 w-4 mr-2" />
        Copy s6 service status command
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {machine.state === "started" && (
        <DropdownMenuItem onClick={() => restartMachine(machine.id)}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Restart
        </DropdownMenuItem>
      )}
      {machine.state === "started" ? (
        <DropdownMenuItem onClick={() => onArchive(machine.id)}>
          <Archive className="h-4 w-4 mr-2" />
          Archive
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onClick={() => onUnarchive(machine.id)}>
          <RotateCcw className="h-4 w-4 mr-2" />
          Restore
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => setDeleteConfirmMachine(machine)}
        className="text-destructive"
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  const getTypeLabel = (machine: Machine) => {
    if (machine.type === "local-docker") {
      return `Local :${machine.metadata?.port ?? "?"}`;
    }
    return "Daytona";
  };

  return (
    <>
      <div className="space-y-3">
        {machines.map((machine) => (
          <div
            key={machine.id}
            className="flex items-start justify-between gap-4 p-4 border rounded-lg bg-card"
          >
            <div className="min-w-0 flex-1 space-y-1">
              {/* Name + State indicator */}
              <div className="flex items-center gap-2">
                <Circle
                  className={`h-2 w-2 shrink-0 ${
                    machine.state === "started"
                      ? "fill-green-500 text-green-500"
                      : "fill-muted text-muted"
                  }`}
                />
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/machine/$machineId"
                  params={{ organizationSlug, projectSlug, machineId: machine.id }}
                  className="font-medium hover:underline truncate"
                >
                  {machine.name}
                </Link>
              </div>

              {/* Meta info */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className={machine.type === "local-docker" ? "text-orange-600" : ""}>
                  {getTypeLabel(machine)}
                </span>
                <span>·</span>
                <span>{formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}</span>
                {machine.metadata?.snapshotName && (
                  <>
                    <span className="hidden sm:inline">·</span>
                    <span className="hidden sm:inline font-mono text-xs">
                      {machine.metadata.snapshotName}
                    </span>
                  </>
                )}
              </div>

              {/* ID */}
              <div className="pt-1">
                <TypeId id={machine.id} />
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              {renderDropdownContent(machine)}
            </DropdownMenu>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!deleteConfirmMachine}
        onOpenChange={(open) => !open && setDeleteConfirmMachine(null)}
        title="Delete machine?"
        description={`This will permanently delete ${deleteConfirmMachine?.name}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteConfirmMachine && onDelete(deleteConfirmMachine.id)}
        destructive
      />
    </>
  );
}
