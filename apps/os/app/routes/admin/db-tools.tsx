import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useTRPC, trpcClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";

export default function AdminDBToolsPage() {
  const trpc = useTRPC();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    deletedUser: string;
    deletedOrganizations: string[];
    deletedEstates: string[];
  } | null>(null);

  const deleteUserMutation = useMutation(trpc.admin.deleteUserByEmail.mutationOptions({}));

  const handleDelete = async () => {
    setError(null);
    setResult(null);
    try {
      const user = await trpcClient.admin.findUserByEmail.query({ email });
      if (!user) {
        setError("User not found");
        return;
      }

      const confirmed = window.confirm(
        `Delete user ${user.name} (${user.email})?\n\nThis will delete all organizations owned by this user, including all estates and associated data.\n\nThis action cannot be undone.`,
      );

      if (!confirmed) return;

      const deleteResult = await deleteUserMutation.mutateAsync({ email: user.email });
      setResult(deleteResult);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Database Tools</h2>
        <p className="text-sm text-muted-foreground">Destructive operations</p>
      </div>

      <div className="space-y-4 border rounded-md p-6">
        <div>
          <div className="font-semibold mb-1">Delete User</div>
          <div className="text-sm text-muted-foreground">
            Permanently delete a user and all associated organizations and estates.
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="flex gap-2">
            <Input
              id="email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && email && handleDelete()}
            />
            <Button variant="destructive" onClick={handleDelete} disabled={!email}>
              Delete
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert>
            <AlertDescription>
              Deleted user {result.deletedUser} with {result.deletedOrganizations.length}{" "}
              organizations and {result.deletedEstates.length} estates
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
