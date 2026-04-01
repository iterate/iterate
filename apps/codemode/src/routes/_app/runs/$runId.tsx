import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { buildCodemodeNewRunSearch } from "~/lib/codemode-links.ts";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { getRun } from "~/lib/runs.ts";

export const Route = createFileRoute("/_app/runs/$runId")({
  loader: ({ params }) => getRun({ data: { id: params.runId } }),
  component: RunDetailPage,
});

function RunDetailPage() {
  const { run } = Route.useLoaderData();
  const resultLanguage = detectCodeLanguage(run.result);
  const errorLanguage = detectCodeLanguage(run.error ?? "");
  const logs = run.logs.join("\n");
  const sourcesYaml = formatCodemodeSourcesYaml(run.sources);

  return (
    <section className="w-full space-y-6 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Saved run</p>
          <p className="text-sm text-muted-foreground">Run ID: {run.id}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            render={
              <Link
                to="/runs-v2-new"
                search={buildCodemodeNewRunSearch({
                  code: run.codeSnippet,
                  sources: run.sources,
                })}
              />
            }
          >
            Re-run
          </Button>
          <Button render={<Link to="/runs-v2-new" />}>New</Button>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Code</p>
        <SourceCodeBlock code={run.codeSnippet} language="typescript" className="min-h-[20rem]" />
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Sources</p>
        <SourceCodeBlock code={sourcesYaml} language="text" className="min-h-40" />
      </div>

      {run.error ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
          <p className="text-sm font-medium text-destructive">Error</p>
          <SourceCodeBlock code={run.error} language={errorLanguage} className="min-h-32" />
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Result</p>
        <SourceCodeBlock code={run.result} language={resultLanguage} className="min-h-40" />
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Logs</p>
        {run.logs.length > 0 ? (
          <SourceCodeBlock code={logs} language="text" className="min-h-32" />
        ) : (
          <p className="text-sm text-muted-foreground">No logs captured.</p>
        )}
      </div>
    </section>
  );
}

function detectCodeLanguage(value: string) {
  if (!value.trim()) return "text" as const;

  try {
    JSON.parse(value);
    return "json" as const;
  } catch {
    return "text" as const;
  }
}
