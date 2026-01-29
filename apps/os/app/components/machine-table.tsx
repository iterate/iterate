import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import {
  MoreHorizontal,
  Archive,
  Trash2,
  SquareTerminal,
  Terminal,
  RefreshCw,
  Circle,
} from "lucide-react";
import { toast } from "sonner";
import { DaemonStatus } from "./daemon-status.tsx";
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
  state: "starting" | "active" | "archived";
  createdAt: Date;
  metadata: {
    snapshotName?: string;
    containerId?: string;
    port?: number;
    ports?: Record<string, number>;
    host?: string;
    daemonStatus?: "ready" | "error" | "restarting" | "stopping";
    daemonReadyAt?: string;
    daemonStatusMessage?: string;
  } & Record<string, unknown>;
  displayInfo: {
    label: string;
    isDevOnly?: boolean;
  };
  commands: Array<{
    label: string;
    command: string;
  }>;
  terminalOptions: Array<{
    label: string;
    url: string;
  }>;
}

interface MachineTableProps {
  machines: Machine[];
  organizationSlug: string;
  projectSlug: string;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onRestart: (id: string) => void;
  isLoading?: boolean;
}

export function MachineTable({
  machines,
  organizationSlug,
  projectSlug,
  onArchive,
  onDelete,
  onRestart,
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

  const copyCommand = (command: string, label: string) => {
    copyToClipboard(command, `Copied ${label}:`, "");
  };

  // === Dropdown menu (terminal, logs, machine actions) ===
  const renderDropdownContent = (machine: Machine) => (
    <DropdownMenuContent align="end" className="w-56">
      {/* Terminal options */}
      {machine.terminalOptions.map((option, index) => (
        <DropdownMenuItem key={index} onClick={() => window.open(option.url, "_blank")}>
          <SquareTerminal className="h-4 w-4 mr-2" />
          Terminal ({option.label})
        </DropdownMenuItem>
      ))}
      {machine.commands.length > 0 && (
        <>
          <DropdownMenuSeparator />
          {machine.commands.map((cmd, index) => (
            <DropdownMenuItem key={index} onClick={() => copyCommand(cmd.command, cmd.label)}>
              <Terminal className="h-4 w-4 mr-2" />
              Copy: {cmd.label}
            </DropdownMenuItem>
          ))}
        </>
      )}
      <DropdownMenuSeparator />

      {/* Machine actions */}
      {machine.state !== "archived" && (
        <DropdownMenuItem onClick={() => onRestart(machine.id)}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Restart
        </DropdownMenuItem>
      )}
      {machine.state !== "archived" && (
        <DropdownMenuItem onClick={() => onArchive(machine.id)}>
          <Archive className="h-4 w-4 mr-2" />
          Archive
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
    return machine.displayInfo.label;
  };

  return (
    <>
      <div className="space-y-3">
        {machines.map((machine) => (
          <Link
            key={machine.id}
            to="/orgs/$organizationSlug/projects/$projectSlug/machines/$machineId"
            params={{ organizationSlug, projectSlug, machineId: machine.id }}
            className="flex items-start justify-between gap-4 p-4 border rounded-lg bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="min-w-0 flex-1 space-y-1">
              {/* Name + State indicator */}
              <div className="flex items-center gap-2">
                <Circle
                  className={`h-2 w-2 shrink-0 ${
                    machine.state === "active"
                      ? "fill-green-500 text-green-500"
                      : machine.state === "starting"
                        ? "fill-yellow-500 text-yellow-500"
                        : "fill-muted text-muted"
                  }`}
                />
                <span className="font-medium truncate">{machine.name}</span>
              </div>

              {/* Meta info */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className={machine.displayInfo.isDevOnly ? "text-orange-600" : ""}>
                  {getTypeLabel(machine)}
                </span>
                <span>·</span>
                <DaemonStatus
                  state={machine.state}
                  daemonStatus={machine.metadata.daemonStatus}
                  daemonReadyAt={machine.metadata.daemonReadyAt}
                  daemonStatusMessage={machine.metadata.daemonStatusMessage}
                />
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              {renderDropdownContent(machine)}
            </DropdownMenu>
          </Link>
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
