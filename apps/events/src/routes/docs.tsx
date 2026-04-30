import { Link, createFileRoute } from "@tanstack/react-router";
import { processorDocs } from "~/lib/processor-docs.ts";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

function DocsPage() {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Event docs</h2>
        <p className="text-sm text-muted-foreground">
          Processor contracts generate these pages. Add or change a processor contract to change the
          docs.
        </p>
      </div>

      <div className="space-y-3">
        {processorDocs.map((processor) => (
          <div key={processor.contract.slug} className="rounded-lg border bg-card p-4">
            <div className="space-y-1">
              <Link to={processor.href} className="block font-medium hover:underline">
                {processor.contract.slug}
              </Link>
              <p className="text-sm text-muted-foreground">{processor.contract.description}</p>
              <p className="text-xs text-muted-foreground">
                {processor.events.length} event{processor.events.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
