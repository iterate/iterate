import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { getOrpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const helloMutation = useMutation({
    mutationFn: () => getOrpcClient().hello({ name: "world" }),
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 p-4">
      <div className="space-y-1">
        <p className="text-xl font-semibold">hello world</p>
        <p className="text-sm text-muted-foreground">
          Tiny agents app with the shared PostHog and oRPC plumbing still wired up.
        </p>
      </div>

      <button
        type="button"
        className="inline-flex w-fit items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={helloMutation.isPending}
        onClick={() => helloMutation.mutate()}
      >
        {helloMutation.isPending ? "Calling..." : "Call sample procedure"}
      </button>

      {helloMutation.data ? (
        <p data-testid="hello-result" className="text-sm">
          {helloMutation.data.message}
        </p>
      ) : null}

      {helloMutation.error ? (
        <p role="alert" className="text-sm text-destructive">
          {helloMutation.error.message}
        </p>
      ) : null}
    </main>
  );
}
