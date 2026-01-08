import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated } from "@tanstack/react-router";

export const Route = createFileRoute("/test-page")({
  component: RouteComponent,
});

function RouteComponent() {
  const slowMutation = useMutation({
    mutationFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
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
