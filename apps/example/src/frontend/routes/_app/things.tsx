import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { orpc } from "@/frontend/lib/orpc.ts";

const thingsListQueryOptions = {
  ...orpc.things.list.queryOptions({ input: { limit: 20, offset: 0 } }),
  staleTime: 30_000,
};

export const Route = createFileRoute("/_app/things")({
  component: ThingsPage,
});

function ThingsPage() {
  const queryClient = useQueryClient();
  const [newThing, setNewThing] = useState("");
  const { data: thingsData } = useQuery(thingsListQueryOptions);

  const createThing = useMutation(
    orpc.things.create.mutationOptions({
      onSuccess: () => {
        setNewThing("");
        void queryClient.invalidateQueries({ queryKey: orpc.things.list.key() });
      },
    }),
  );

  const deleteThing = useMutation(
    orpc.things.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.things.list.key() });
      },
    }),
  );

  const handleCreate = useCallback(() => {
    const thing = newThing.trim();
    if (!thing) return;
    createThing.mutate({ thing });
  }, [createThing, newThing]);

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Things</h2>
        <p className="text-sm text-muted-foreground">CRUD backed by Drizzle + SQLite/D1</p>
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="New thing..."
          value={newThing}
          onChange={(event) => setNewThing(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleCreate()}
        />
        <Button
          size="sm"
          disabled={createThing.isPending || !newThing.trim()}
          onClick={handleCreate}
        >
          {createThing.isPending ? "Adding..." : "Add"}
        </Button>
      </div>

      <div className="space-y-3">
        {thingsData?.things.map((thing) => (
          <div
            key={thing.id}
            className="flex items-center justify-between rounded-md border p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{thing.thing}</div>
              <div className="text-xs text-muted-foreground">{thing.id.slice(0, 8)}</div>
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteThing.mutate({ id: thing.id })}
              disabled={deleteThing.isPending && deleteThing.variables?.id === thing.id}
            >
              {deleteThing.isPending && deleteThing.variables?.id === thing.id
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        ))}
      </div>

      {thingsData && thingsData.things.length === 0 && (
        <p className="text-sm text-muted-foreground">No things yet. Create one above.</p>
      )}
    </section>
  );
}
