import { EventType } from "~/components/event-type.tsx";
import { type EventTypePageDefinition } from "~/lib/event-type-pages.ts";

export function EventTypePageView({ page }: { page: EventTypePageDefinition }) {
  const defaultEventExample = {
    type: page.type,
    payload: page.payloadExample ?? {},
  };

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Event type</p>
        <h2 className="text-lg font-semibold">{page.title}</h2>
        <p className="text-sm text-muted-foreground">{page.summary}</p>
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Type URL</p>
          <div className="rounded-md bg-muted p-3 text-xs">
            <EventType type={page.type} className="whitespace-pre-wrap wrap-break-word" />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Route</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {page.href}
          </pre>
        </div>
      </div>

      {page.details?.length ? (
        <div className="space-y-2 rounded-lg border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Notes</p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {page.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {page.payloadExample ? (
        <div className="space-y-2 rounded-lg border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Example payload</p>
          <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
            {JSON.stringify(page.payloadExample, null, 2)}
          </pre>
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Example event input</p>
        <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
          {JSON.stringify(defaultEventExample, null, 2)}
        </pre>
      </div>

      {page.templates?.length ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            More input examples
          </p>
          {page.templates.map((template) => (
            <div key={template.id} className="space-y-2">
              <p className="text-sm font-medium">{template.label}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(template.event, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <a href="/docs" className="text-sm text-primary hover:underline">
          Event docs
        </a>
      </div>
    </section>
  );
}
