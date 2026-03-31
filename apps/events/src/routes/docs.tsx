import { Link, createFileRoute } from "@tanstack/react-router";
import { EventType } from "~/components/event-type.tsx";
import { eventTypePages } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

function DocsPage() {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Event docs</h2>
        <p className="text-sm text-muted-foreground">
          Add a small route file in `src/routes/` when you want a real page for a specific event
          type.
        </p>
      </div>

      <div className="space-y-3">
        {eventTypePages.map((page) => (
          <div key={page.slug} className="rounded-lg border bg-card p-4">
            <div className="space-y-1">
              <Link to={page.href} className="block font-medium hover:underline">
                {page.title}
              </Link>
              <p className="text-sm text-muted-foreground">{page.summary}</p>
              <EventType type={page.type} className="text-xs" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
