import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import { codemodeInputLanguage } from "~/lib/codemode-input.ts";
import { buildCodemodeNewRunSearch } from "~/lib/codemode-links.ts";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";
import { summarizeCodeSnippet } from "~/lib/run-preview.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/runs/$runId")({
  loader: async ({ context, params }) => {
    const run = await context.queryClient.ensureQueryData({
      ...orpc.runs.find.queryOptions({ input: { id: params.runId } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: summarizeCodeSnippet(run.codeSnippet),
      run,
    };
  },
  component: RunDetailPage,
});

function RunDetailPage() {
  const { run } = Route.useLoaderData();
  const isSuccess = run.error === null;
  const result = run.result.trim();
  const logs = run.logs.join("\n").trim();
  const resultLanguage = detectCodeLanguage(run.result);
  const sourcesYaml = formatCodemodeSourcesYaml(run.sources);

  return (
    <section className="w-full space-y-6 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium",
              isSuccess
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-700"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            <span
              className={cn("size-2 rounded-full", isSuccess ? "bg-emerald-500" : "bg-destructive")}
            />
            {isSuccess ? "Succeeded" : "Failed"}
          </div>
          <p className="text-sm text-muted-foreground">Run ID: {run.id}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            render={
              <Link
                to="/runs-v2-new"
                search={buildCodemodeNewRunSearch({
                  input: run.input,
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

      <div
        className={cn(
          "space-y-3 rounded-lg border p-4",
          isSuccess
            ? "border-emerald-400/40 bg-emerald-500/5"
            : "border-destructive/35 bg-destructive/5",
        )}
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">Result</p>
          <p className={cn("text-sm", isSuccess ? "text-emerald-700" : "text-destructive")}>
            {isSuccess ? "Execution completed successfully." : run.error}
          </p>
        </div>

        {result ? (
          <SourceCodeBlock code={run.result} language={resultLanguage} className="min-h-[20rem]" />
        ) : (
          <p className="text-sm text-muted-foreground">No output.</p>
        )}
      </div>

      {logs ? (
        <div className="space-y-2 border-t pt-6">
          <p className="text-sm font-medium">Logs</p>
          <SourceCodeBlock code={logs} language="text" className="min-h-40" />
        </div>
      ) : null}

      <div className="space-y-2 border-t pt-6">
        <p className="text-sm font-medium">Code</p>
        <SourceCodeBlock
          code={run.codeSnippet}
          language={codemodeInputLanguage(run.input)}
          className="min-h-[20rem]"
        />
      </div>

      <div className="space-y-2 border-t pt-6">
        <p className="text-sm font-medium">Sources</p>
        <SourceCodeBlock code={sourcesYaml} language="text" className="min-h-40" />
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
