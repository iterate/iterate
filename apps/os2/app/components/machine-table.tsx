import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  MoreHorizontal,
  Archive,
  Trash2,
  RotateCcw,
  ExternalLink,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../lib/trpc.tsx";
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
import { Spinner } from "./ui/spinner.tsx";

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
  const [previewDialogMachineId, setPreviewDialogMachineId] = useState<string | null>(null);

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
                <Badge variant="outline">{machine.type}</Badge>
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
                    <DropdownMenuItem onClick={() => setPreviewDialogMachineId(machine.id)}>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Preview
                    </DropdownMenuItem>
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

      <MachinePreviewDialog
        machineId={previewDialogMachineId}
        machineName={machines.find((m) => m.id === previewDialogMachineId)?.name}
        organizationSlug={organizationSlug}
        projectSlug={projectSlug}
        onClose={() => setPreviewDialogMachineId(null)}
      />
    </>
  );
}

function MachinePreviewDialog({
  machineId,
  machineName,
  organizationSlug,
  projectSlug,
  onClose,
}: {
  machineId: string | null;
  machineName?: string;
  organizationSlug: string;
  projectSlug: string;
  onClose: () => void;
}) {
  const [copiedField, setCopiedField] = useState<"url" | "token" | null>(null);

  const { data, isLoading, error } = useQuery({
    ...trpc.machine.getPreviewInfo.queryOptions({
      organizationSlug,
      projectSlug,
      machineId: machineId ?? "",
    }),
    enabled: !!machineId,
  });

  const handleCopy = async (text: string, field: "url" | "token") => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedField(null), 2000);
  };

  return (
    <Dialog open={!!machineId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Machine Preview</DialogTitle>
          <DialogDescription>
            {machineName
              ? `Preview URL and credentials for ${machineName}`
              : "Preview URL and credentials"}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-6 w-6" />
          </div>
        )}

        {error && (
          <div className="text-destructive text-sm py-4">
            Failed to load preview info: {error.message}
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Preview URL</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm break-all">
                  {data.url}
                </code>
                <Button variant="outline" size="icon" onClick={() => handleCopy(data.url, "url")}>
                  {copiedField === "url" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
                <Button variant="outline" size="icon" asChild>
                  <a href={data.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Headers</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono break-all">
                  {Object.entries(data.headers).map(([key, value]) => (
                    <div key={key}>
                      {key}: {value}
                    </div>
                  ))}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleCopy(data.headers.Authorization, "token")}
                >
                  {copiedField === "token" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
