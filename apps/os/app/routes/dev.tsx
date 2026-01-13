import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated } from "@tanstack/react-router";

// dev-only page for testing the test helpers, debugging etc. Dump whatever you want in here (if you don't want it deleted, write a test protecting it)

export const Route = createFileRoute("/dev")({
  component: RouteComponent,
});

function RouteComponent() {
  const slowMutation = useMutation({
    mutationFn: async () => {
      const timeout =
        Number(new URL(window.location.href).searchParams.get("slowMutationTimeout")) || 2_000;
      await new Promise((resolve) => setTimeout(resolve, timeout));
      return "done";
    },
  });
  const hydrated = useHydrated();

  return (
    <div>
      <button disabled={!hydrated} onClick={() => slowMutation.mutate()}>
        slow button:
        {slowMutation.isError && "error"}
        {slowMutation.isPending && "loading..."}
        {slowMutation.isSuccess && "i have been clicked"}
      </button>
    </div>
  );
}
