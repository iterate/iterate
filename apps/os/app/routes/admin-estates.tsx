import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { MoreVertical } from "lucide-react";
import { useTRPC, useTRPCClient } from "../lib/trpc.ts";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";

export default function AdminEstatesPage() {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const { data: estates } = useSuspenseQuery(trpc.admin.listAllEstates.queryOptions());

  const impersonateMutation = useMutation({
    mutationFn: async (userId: string) => {
      return authClient.admin.impersonateUser({ userId });
    },
    onSuccess: (data) => {
      if (data?.user?.email) window.location.href = "/";
    },
  });

  const rebuildMutation = useMutation({
    mutationFn: async (estateId: string) => {
      return trpcClient.admin.rebuildEstate.mutate({ estateId });
    },
  });

  const rebuildAllMutation = useMutation({
    mutationFn: async () => {
      return trpcClient.admin.rebuildAllEstates.mutate();
    },
  });

  const syncSlackUsersMutation = useMutation({
    mutationFn: async (estateId: string) => {
      return trpcClient.admin.syncSlackUsersForEstate.mutate({ estateId });
    },
  });

  const syncAllSlackUsersMutation = useMutation({
    mutationFn: async () => {
      return trpcClient.admin.syncSlackUsersForAllEstates.mutate();
    },
  });

  const handleImpersonate = (ownerId: string | undefined) => {
    if (!ownerId) {
      alert("No owner found for this estate");
      return;
    }
    if (confirm("Impersonate this estate's owner?")) {
      impersonateMutation.mutate(ownerId);
    }
  };

  const handleRebuild = (estateId: string, estateName: string) => {
    if (confirm(`Rebuild estate "${estateName}"?`)) {
      rebuildMutation.mutate(estateId);
    }
  };

  const handleRebuildAll = () => {
    if (
      confirm(
        `Rebuild ALL ${estates.length} estates? This may take a while and trigger many builds.`,
      )
    ) {
      rebuildAllMutation.mutate();
    }
  };

  const handleSyncSlackUsers = (estateId: string, estateName: string) => {
    if (confirm(`Sync Slack users for estate "${estateName}"?`)) {
      syncSlackUsersMutation.mutate(estateId);
    }
  };

  const handleSyncAllSlackUsers = () => {
    if (confirm(`Sync Slack users for ALL ${estates.length} estates? This may take a while.`)) {
      syncAllSlackUsersMutation.mutate();
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Estates</h2>
          <p className="text-muted-foreground">
            Manage all estates in the system ({estates.length} total)
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleSyncAllSlackUsers}
            variant="outline"
            disabled={syncAllSlackUsersMutation.isPending}
          >
            {syncAllSlackUsersMutation.isPending ? "Syncing..." : "Sync All Slack Users"}
          </Button>
          <Button
            onClick={handleRebuildAll}
            variant="outline"
            disabled={rebuildAllMutation.isPending}
          >
            {rebuildAllMutation.isPending ? "Rebuilding..." : "Rebuild All"}
          </Button>
        </div>
      </div>

      {syncAllSlackUsersMutation.isSuccess && (
        <div className="p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md">
          <div className="font-semibold text-green-900 dark:text-green-100">
            Sync All Slack Users Started
          </div>
          <div className="text-sm text-green-800 dark:text-green-200 mt-1">
            {syncAllSlackUsersMutation.data.total} estates queued for syncing in background
          </div>
        </div>
      )}

      {rebuildAllMutation.isSuccess && (
        <div className="p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md">
          <div className="font-semibold text-green-900 dark:text-green-100">
            Rebuild All Complete
          </div>
          <div className="text-sm text-green-800 dark:text-green-200 mt-1">
            {rebuildAllMutation.data.total} estates processed
          </div>
          <div className="space-y-1 text-sm mt-3">
            {rebuildAllMutation.data.results.map((result) => (
              <div
                key={result.estateId}
                className={
                  result.success
                    ? "text-green-700 dark:text-green-300"
                    : "text-red-700 dark:text-red-300"
                }
              >
                {result.estateName}:{" "}
                {result.success
                  ? "✓ Success"
                  : `✗ ${"error" in result ? result.error : "Unknown error"}`}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Estate Name</TableHead>
              <TableHead>Estate ID</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Organization ID</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Owner Email</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {estates.map((estate) => (
              <TableRow key={estate.id}>
                <TableCell className="font-medium">{estate.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground font-mono">
                  {estate.id}
                </TableCell>
                <TableCell>{estate.organizationName}</TableCell>
                <TableCell className="text-xs text-muted-foreground font-mono">
                  {estate.organizationId}
                </TableCell>
                <TableCell>{estate.ownerName || "No name"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {estate.ownerEmail || "No email"}
                </TableCell>
                <TableCell>
                  {estate.connectedRepoId ? (
                    <span className="text-xs text-muted-foreground">
                      {estate.connectedRepoPath || "/"} @ {estate.connectedRepoRef || "main"}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">No repo</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(estate.updatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleImpersonate(estate.ownerId)}
                        disabled={!estate.ownerId || impersonateMutation.isPending}
                      >
                        Impersonate Owner
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleRebuild(estate.id, estate.name)}
                        disabled={
                          !estate.connectedRepoId ||
                          rebuildMutation.isPending ||
                          rebuildAllMutation.isPending
                        }
                      >
                        Rebuild
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleSyncSlackUsers(estate.id, estate.name)}
                        disabled={syncSlackUsersMutation.isPending}
                      >
                        Sync Slack Users
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
