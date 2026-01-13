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
} from "lucide-react";
import { toast } from "sonner";
import { trpcClient } from "../lib/trpc.tsx";
import { TypeId } from "./type-id.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ConfirmDialog } from "./ui/confirm-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

interface Machine {
  id: string;
  name: string;
  type: string;
  state: "started" | "archived";
  createdAt: Date;
  metadata: { snapshotName?: string } & Record<string, unknown>;
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

  const openDaemon = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    window.open(result.daemonUrl, "_blank");
  };

  const openTerminal = async (machineId: string) => {
    const result = await trpcClient.machine.getPreviewInfo.query({
      organizationSlug,
      projectSlug,
      machineId,
    });
    window.open(result.terminalUrl, "_blank");
  };

  const copyLogsCommand = async (machine: Machine, type: "daemon" | "entry") => {
    const containerId = (machine.metadata as { containerId?: string })?.containerId;
    if (!containerId) {
      toast.error("Container ID not found");
      return;
    }

    const command =
      type === "daemon"
        ? `docker exec ${containerId} tail -f /var/log/iterate-server/current`
        : `docker logs -f ${containerId}`;

    await navigator.clipboard.writeText(command);
    toast.success(
      <div className="space-y-1">
        <div>Copied to clipboard:</div>
        <code className="block text-xs font-mono bg-black/10 dark:bg-white/10 px-2 py-1.5 rounded border border-black/10 dark:border-white/10">
          {command}
        </code>
        {type === "daemon" && (
          <div className="text-xs text-muted-foreground mt-2">
            Note: Won't work until entry.ts has finished starting daemons
          </div>
        )}
      </div>,
    );
  };

  const copyShellCommand = async (machine: Machine) => {
    const containerId = (machine.metadata as { containerId?: string })?.containerId;
    if (!containerId) {
      toast.error("Container ID not found");
      return;
    }

    const command = `docker exec -it ${containerId} /bin/bash`;
    await navigator.clipboard.writeText(command);
    toast.success(
      <div className="space-y-1">
        <div>Copied to clipboard:</div>
        <code className="block text-xs font-mono bg-black/10 dark:bg-white/10 px-2 py-1.5 rounded border border-black/10 dark:border-white/10">
          {command}
        </code>
      </div>,
    );
  };

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

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Snapshot</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {machines.map((machine) => (
            <TableRow key={machine.id}>
              <TableCell>
                <TypeId id={machine.id} />
              </TableCell>
              <TableCell className="font-medium">
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/machine/$machineId"
                  params={{ organizationSlug, projectSlug, machineId: machine.id }}
                  className="hover:underline"
                >
                  {machine.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs font-mono">
                {machine.metadata?.snapshotName ?? "-"}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    machine.type === "local-docker" ? "border-orange-500 text-orange-600" : ""
                  }
                >
                  {machine.type === "local-docker"
                    ? `Local :${(machine.metadata as { port?: number })?.port ?? "?"}`
                    : "Daytona"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={machine.state === "started" ? "success" : "secondary"}>
                  {machine.state}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openDaemon(machine.id)}>
                      <Monitor className="h-4 w-4 mr-2" />
                      Open Daemon
                    </DropdownMenuItem>
                    {machine.state === "started" && (
                      <DropdownMenuItem onClick={() => restartMachine(machine.id)}>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Restart
                      </DropdownMenuItem>
                    )}
                    {machine.type === "local-docker" && (
                      <>
                        <DropdownMenuItem onClick={() => copyShellCommand(machine)}>
                          <Terminal className="h-4 w-4 mr-2" />
                          Copy shell command
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyLogsCommand(machine, "daemon")}>
                          <ScrollText className="h-4 w-4 mr-2" />
                          <span>
                            Copy daemon logs command
                            <span className="block text-xs text-muted-foreground">
                              Won't work until entry.ts starts daemons
                            </span>
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyLogsCommand(machine, "entry")}>
                          <ScrollText className="h-4 w-4 mr-2" />
                          Copy entry.ts logs command
                        </DropdownMenuItem>
                      </>
                    )}
                    {machine.type === "daytona" && (
                      <DropdownMenuItem onClick={() => openTerminal(machine.id)}>
                        <SquareTerminal className="h-4 w-4 mr-2" />
                        Terminal
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
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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
