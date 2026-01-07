import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/$projectSlug/")({
  component: MachinesPage,
});

function MachinesPage() {
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryInput = { organizationSlug, projectSlug };

  const { data: machines } = useSuspenseQuery(trpc.machine.list.queryOptions(queryInput));

  const createMachine = useMutation(
    trpc.machine.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.machine.list.queryKey(queryInput) });
      },
    }),
  );

  const archiveMachine = useMutation(
    trpc.machine.archive.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.machine.list.queryKey(queryInput) });
      },
    }),
  );

  if (machines.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>No Machines</CardTitle>
            <CardDescription>Create your first machine to get started.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => createMachine.mutate(queryInput)}
              disabled={createMachine.isPending}
              className="w-full"
            >
              {createMachine.isPending ? "Creating..." : "Create Machine"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Machines</h1>
        <Button onClick={() => createMachine.mutate(queryInput)} disabled={createMachine.isPending}>
          {createMachine.isPending ? "Creating..." : "New Machine"}
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {machines.map((machine) => {
          const isArchived = machine.state === "archived";
          return (
            <Card key={machine.id} className={isArchived ? "opacity-50" : undefined}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{machine.id}</CardTitle>
                  <span
                    className={`text-xs px-2 py-1 rounded ${isArchived ? "bg-muted text-muted-foreground" : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"}`}
                  >
                    {machine.state}
                  </span>
                </div>
                <CardDescription>Type: {machine.type}</CardDescription>
              </CardHeader>
              {!isArchived && (
                <CardContent>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => archiveMachine.mutate({ ...queryInput, machineId: machine.id })}
                    disabled={archiveMachine.isPending}
                  >
                    Archive
                  </Button>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
