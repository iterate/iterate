import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";

type CounterState = {
  count: number;
  updatedAt: string | null;
};

const counterQueryKey = ["durable-counter"] as const;

export const Route = createFileRoute("/_app/durable-object")({
  staticData: {
    breadcrumb: "Durable Object",
  },
  component: DurableObjectPage,
});

function DurableObjectPage() {
  const queryClient = useQueryClient();
  const counter = useQuery({
    queryKey: counterQueryKey,
    queryFn: () => fetchCounter("/api/durable-counter"),
    retry: false,
  });
  const increment = useMutation({
    mutationFn: () => fetchCounter("/api/durable-counter/increment", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(counterQueryKey, data);
    },
  });
  const reset = useMutation({
    mutationFn: () => fetchCounter("/api/durable-counter/reset", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(counterQueryKey, data);
    },
  });
  const busy = counter.isPending || increment.isPending || reset.isPending;

  return (
    <div className="space-y-4 p-4">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Durable Object Counter</h2>
          <p className="text-sm text-muted-foreground">
            A named Durable Object stores this count in Cloudflare storage.
          </p>
        </div>

        {counter.isError ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Durable Object endpoints are available in the Cloudflare runtime.
          </p>
        ) : (
          <div className="space-y-1">
            <p className="text-4xl font-semibold tabular-nums">{counter.data?.count ?? 0}</p>
            <p className="text-sm text-muted-foreground">
              {counter.data?.updatedAt
                ? `Last updated ${new Date(counter.data.updatedAt).toLocaleString()}`
                : "Not updated yet"}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || counter.isError} onClick={() => increment.mutate()}>
            Increment
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || counter.isError}
            onClick={() => reset.mutate()}
          >
            Reset
          </Button>
        </div>
      </section>
    </div>
  );
}

async function fetchCounter(path: string, init?: RequestInit): Promise<CounterState> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Counter request failed: ${response.status}`);
  }

  return parseCounterState(await response.json());
}

function parseCounterState(value: unknown): CounterState {
  if (!isRecord(value) || typeof value.count !== "number") {
    throw new Error("Counter response was not valid.");
  }

  return {
    count: value.count,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
