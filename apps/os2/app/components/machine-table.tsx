import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  MoreHorizontal,
  Archive,
  Trash2,
  RotateCcw,
  Monitor,
  ScrollText,
  Copy,
  Check,
  SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";
import { trpcClient } from "../lib/trpc.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
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
  const [logsDialogMachine, setLogsDialogMachine] = useState<Machine | null>(null);

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

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
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
              <TableCell className="font-medium">{machine.name}</TableCell>
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
                    {machine.type === "local-docker" && (
                      <DropdownMenuItem onClick={() => setLogsDialogMachine(machine)}>
                        <ScrollText className="h-4 w-4 mr-2" />
                        View Logs
                      </DropdownMenuItem>
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
                      onClick={() => onDelete(machine.id)}
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

      <LogsDialog machine={logsDialogMachine} onClose={() => setLogsDialogMachine(null)} />
    </>
  );
}

function LogsDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const containerId = (machine?.metadata as { containerId?: string })?.containerId;
  const command = containerId ? `docker logs -f ${containerId}` : "Container ID not found";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={!!machine} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>View Container Logs</DialogTitle>
          <DialogDescription>
            Run this command in your terminal to tail the logs for {machine?.name}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono break-all">
              {command}
            </code>
            <Button variant="outline" size="icon" onClick={handleCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
