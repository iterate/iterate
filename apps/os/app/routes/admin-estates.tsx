import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "../lib/trpc.ts";
import { authClient } from "../lib/auth-client.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";

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

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Estates</h2>
          <p className="text-muted-foreground">
            Manage all estates in the system ({estates.length} total)
          </p>
        </div>
        <Button
          onClick={handleRebuildAll}
          variant="outline"
          disabled={rebuildAllMutation.isPending}
        >
          {rebuildAllMutation.isPending ? "Rebuilding..." : "Rebuild All"}
        </Button>
      </div>

      {rebuildAllMutation.isSuccess && (
        <Card className="bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
          <CardHeader>
            <CardTitle className="text-green-900 dark:text-green-100">
              Rebuild All Complete
            </CardTitle>
            <CardDescription className="text-green-800 dark:text-green-200">
              {rebuildAllMutation.data.total} estates processed
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All Estates</CardTitle>
          <CardDescription>List of all estates with their owners</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Estate Name</TableHead>
                <TableHead>Estate ID</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Owner</TableHead>
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
                  <TableCell>{estate.ownerName || estate.ownerEmail || "No owner"}</TableCell>
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
                  <TableCell className="text-right space-x-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleImpersonate(estate.ownerId)}
                      disabled={!estate.ownerId || impersonateMutation.isPending}
                    >
                      Impersonate Owner
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRebuild(estate.id, estate.name)}
                      disabled={
                        !estate.connectedRepoId ||
                        rebuildMutation.isPending ||
                        rebuildAllMutation.isPending
                      }
                    >
                      {rebuildMutation.isPending ? "..." : "Rebuild"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
