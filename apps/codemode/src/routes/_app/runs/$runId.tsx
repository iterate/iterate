import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { getRun } from "~/lib/runs.ts";

export const Route = createFileRoute("/_app/runs/$runId")({
  loader: ({ params }) => getRun({ data: { id: params.runId } }),
  component: RunDetailPage,
});

function RunDetailPage() {
  const { run } = Route.useLoaderData();

  return (
    <section className="max-w-md space-y-6 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Saved run</p>
          <p className="text-sm text-muted-foreground">Run ID: {run.id}</p>
        </div>

        <Button render={<Link to="/runs/new" />}>New</Button>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Code</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm">
          {run.codeSnippet}
        </pre>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Result</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm">
          {run.result}
        </pre>
      </div>
    </section>
  );
}
