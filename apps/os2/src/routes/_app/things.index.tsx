import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/things/")({
  component: ThingsIndexPage,
});

function ThingsIndexPage() {
  const queryClient = useQueryClient();
  const [newThing, setNewThing] = useState("");
  const { data: thingsData } = useQuery({
    ...orpc.things.list.queryOptions({ input: { limit: 20, offset: 0 } }),
    staleTime: 30_000,
  });

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
        <p className="text-sm text-muted-foreground">
          CRUD backed by sqlfu + D1, with each record linking to a nested detail route.
        </p>
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
            className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Link
                to="/things/$thingId"
                params={{ thingId: thing.id }}
                className="block truncate font-medium hover:underline"
              >
                {thing.thing}
              </Link>
              <Identifier value={thing.id} textClassName="text-xs text-muted-foreground" />
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
