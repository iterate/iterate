import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/$instanceSlug/")({
  component: MachinesPage,
});

function MachinesPage() {
  const { organizationSlug, instanceSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [newMachineName, setNewMachineName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({ organizationSlug, instanceSlug }),
  );

  const createMachine = useMutation(trpc.machine.create.mutationOptions());
  const archiveMachine = useMutation(trpc.machine.archive.mutationOptions());
  const deleteMachine = useMutation(trpc.machine.delete.mutationOptions());

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createMachine.mutateAsync({
      organizationSlug,
      instanceSlug,
      name: newMachineName,
      type: "daytona",
    });
    setNewMachineName("");
    setShowCreateForm(false);
    queryClient.invalidateQueries();
    toast.success("Machine created");
  };

  const handleArchive = async (machineId: string) => {
    await archiveMachine.mutateAsync({ organizationSlug, instanceSlug, machineId });
    queryClient.invalidateQueries();
    toast.success("Machine archived");
  };

  const handleDelete = async (machineId: string) => {
    await deleteMachine.mutateAsync({ organizationSlug, instanceSlug, machineId });
    queryClient.invalidateQueries();
    toast.success("Machine deleted");
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Machines</h2>
        <Button onClick={() => setShowCreateForm(true)}>Create Machine</Button>
      </div>

      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle>Create Machine</CardTitle>
            <CardDescription>Add a new machine to this instance</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex gap-2">
              <Input
                placeholder="Machine name"
                value={newMachineName}
                onChange={(e) => setNewMachineName(e.target.value)}
                required
              />
              <Button type="submit" disabled={createMachine.isPending}>
                {createMachine.isPending ? "Creating..." : "Create"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowCreateForm(false)}>
                Cancel
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {machines.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No machines yet. Create your first machine to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">State</th>
                <th className="text-left px-4 py-2">Created</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((machine) => (
                <tr key={machine.id} className="border-t">
                  <td className="px-4 py-2">{machine.name}</td>
                  <td className="px-4 py-2">
                    <span className="text-sm text-muted-foreground">{machine.type}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex px-2 py-1 text-xs rounded-full ${
                        machine.state === "started"
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {machine.state}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-muted-foreground">
                    {new Date(machine.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {machine.state === "started" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleArchive(machine.id)}
                        >
                          Archive
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(machine.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
