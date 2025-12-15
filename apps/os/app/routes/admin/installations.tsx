import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { MoreVertical } from "lucide-react";
import { useState } from "react";
import { useTRPC, useTRPCClient } from "../../lib/trpc.ts";
import { authClient } from "../../lib/auth-client.ts";
import { Button } from "../../components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog.tsx";

export const Route = createFileRoute("/_auth.layout/admin/installations")({
  component: AdminInstallationsPage,
});

function AdminInstallationsPage() {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const { data: installations } = useSuspenseQuery(trpc.admin.listAllInstallations.queryOptions());
  const [showSyncResultsDialog, setShowSyncResultsDialog] = useState(false);

  const impersonateMutation = useMutation({
    mutationFn: async (userId: string) => {
      return authClient.admin.impersonateUser({ userId });
    },
    onSuccess: (data) => {
      if (data?.user?.email) window.location.href = "/";
    },
  });

  const rebuildMutation = useMutation({
    mutationFn: async (installationId: string) => {
      return trpcClient.admin.rebuildInstallation.mutate({ installationId });
    },
  });

  const rebuildAllMutation = useMutation({
    mutationFn: async () => {
      return trpcClient.admin.rebuildAllInstallations.mutate();
    },
  });

  const syncSlackMutation = useMutation({
    mutationFn: async (installationId: string) => {
      return trpcClient.admin.syncSlackForInstallation.mutate({ installationId });
    },
  });

  const syncAllSlackMutation = useMutation({
    mutationFn: async () => {
      return trpcClient.admin.syncSlackForAllInstallations.mutate();
    },
    onSuccess: () => {
      setShowSyncResultsDialog(true);
    },
  });

  const handleImpersonate = (ownerId: string | undefined) => {
    if (!ownerId) {
      alert("No owner found for this installation");
      return;
    }
    if (confirm("Impersonate this installation's owner?")) {
      impersonateMutation.mutate(ownerId);
    }
  };

  const handleRebuild = (installationId: string, installationName: string) => {
    if (confirm(`Rebuild installation "${installationName}"?`)) {
      rebuildMutation.mutate(installationId);
    }
  };

  const handleRebuildAll = () => {
    if (
      confirm(
        `Rebuild ALL ${installations.length} installations? This may take a while and trigger many builds.`,
      )
    ) {
      rebuildAllMutation.mutate();
    }
  };

  const handleSyncSlack = (installationId: string, installationName: string) => {
    if (confirm(`Sync Slack for installation "${installationName}"?`)) {
      syncSlackMutation.mutate(installationId);
    }
  };

  const handleSyncAllSlack = () => {
    if (
      confirm(`Sync Slack for ALL ${installations.length} installations? This may take a while.`)
    ) {
      syncAllSlackMutation.mutate();
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Installations</h2>
          <p className="text-muted-foreground">
            Manage all installations in the system ({installations.length} total)
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleSyncAllSlack}
            variant="outline"
            disabled={syncAllSlackMutation.isPending}
          >
            {syncAllSlackMutation.isPending ? "Syncing..." : "Sync Slack"}
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

      {rebuildAllMutation.isSuccess && (
        <div className="p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md">
          <div className="font-semibold text-green-900 dark:text-green-100">
            Rebuild All Complete
          </div>
          <div className="text-sm text-green-800 dark:text-green-200 mt-1">
            {rebuildAllMutation.data.total} installations processed
          </div>
          <div className="space-y-1 text-sm mt-3">
            {rebuildAllMutation.data.results.map((result) => (
              <div
                key={result.installationId}
                className={
                  result.success
                    ? "text-green-700 dark:text-green-300"
                    : "text-red-700 dark:text-red-300"
                }
              >
                {result.installationName}:{" "}
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
              <TableHead>Installation Name</TableHead>
              <TableHead>Installation ID</TableHead>
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
            {installations.map((installation) => (
              <TableRow key={installation.id}>
                <TableCell className="font-medium">{installation.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground font-mono">
                  {installation.id}
                </TableCell>
                <TableCell>{installation.organizationName}</TableCell>
                <TableCell className="text-xs text-muted-foreground font-mono">
                  {installation.organizationId}
                </TableCell>
                <TableCell>{installation.ownerName || "No name"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {installation.ownerEmail || "No email"}
                </TableCell>
                <TableCell>
                  {installation.connectedRepoId ? (
                    <span className="text-xs text-muted-foreground">
                      {installation.connectedRepoPath || "/"} @{" "}
                      {installation.connectedRepoRef || "main"}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">No repo</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(installation.updatedAt).toLocaleDateString()}
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
                        onClick={() => handleImpersonate(installation.ownerId)}
                        disabled={!installation.ownerId || impersonateMutation.isPending}
                      >
                        Impersonate Owner
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleRebuild(installation.id, installation.name)}
                        disabled={
                          !installation.connectedRepoId ||
                          rebuildMutation.isPending ||
                          rebuildAllMutation.isPending
                        }
                      >
                        Rebuild
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleSyncSlack(installation.id, installation.name)}
                        disabled={syncSlackMutation.isPending}
                      >
                        Sync Slack
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showSyncResultsDialog} onOpenChange={setShowSyncResultsDialog}>
        <DialogContent className="max-w-7xl">
          <DialogHeader>
            <DialogTitle>Slack Sync Results</DialogTitle>
            <DialogDescription>
              {syncAllSlackMutation.data
                ? `Synced ${syncAllSlackMutation.data.total} installations`
                : "Loading..."}
            </DialogDescription>
          </DialogHeader>
          {syncAllSlackMutation.data && (
            <div className="max-h-[60vh] overflow-y-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[200px]">Installation Name</TableHead>
                    <TableHead className="w-[120px]">Installation ID</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncAllSlackMutation.data.results.map((result) => (
                    <TableRow key={result.installationId}>
                      <TableCell className="font-medium">{result.installationName}</TableCell>
                      <TableCell
                        className="text-xs text-muted-foreground font-mono truncate max-w-[120px]"
                        title={result.installationId}
                      >
                        {result.installationId}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {result.success ? (
                          <span className="text-green-600">✓ Success</span>
                        ) : (
                          <span className="text-red-600">✗ Failed</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {result.success ? (
                          "data" in result && result.data ? (
                            <div className="space-y-1">
                              <div>
                                Channels: {result.data.channels.count} (
                                {result.data.channels.sharedCount} shared)
                              </div>
                              <div>
                                Users: {result.data.users.internalCount} internal,{" "}
                                {result.data.users.externalCount} external
                              </div>
                              {result.data.errors.length > 0 && (
                                <div className="text-yellow-600">
                                  Warnings: {result.data.errors.length}
                                </div>
                              )}
                            </div>
                          ) : (
                            "Synced successfully"
                          )
                        ) : (
                          <span className="text-red-600 warp-break-words">
                            {"error" in result ? result.error : "Unknown error"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
