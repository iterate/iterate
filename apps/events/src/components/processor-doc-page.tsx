import { Link } from "@tanstack/react-router";
import { EventType } from "~/components/event-type.tsx";
import type { ProcessorDoc, ProcessorEventDoc } from "~/lib/processor-docs.ts";

export function ProcessorOverviewPage({ processor }: { processor: ProcessorDoc }) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Processor</p>
        <h2 className="text-lg font-semibold">{processor.contract.slug}</h2>
        <p className="text-sm text-muted-foreground">{processor.contract.description}</p>
      </div>

      {processor.processorDeps.length > 0 ? (
        <ProcessorLinks title="Processor deps" processors={processor.processorDeps} />
      ) : null}

      <EventLinks title="Consumes" events={processor.consumes} />
      <EventLinks title="Emits" events={processor.emits} />
      <EventLinks title="Owned events" events={processor.events} />
    </section>
  );
}

export function ProcessorEventPage({ event }: { event: ProcessorEventDoc }) {
  const defaultEventExample = {
    type: event.type,
    payload: {},
  };

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Processor event</p>
        <h2 className="text-lg font-semibold">{`${event.processor.slug}/${event.eventSlug}`}</h2>
        {event.description ? (
          <p className="text-sm text-muted-foreground">{event.description}</p>
        ) : null}
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Type URL</p>
          <div className="rounded-md bg-muted p-3 text-xs">
            <EventType type={event.type} className="whitespace-pre-wrap wrap-break-word" />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Processor</p>
          <Link to={`/${event.processor.slug}/`} className="text-sm text-primary hover:underline">
            {event.processor.slug}
          </Link>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Payload JSON schema</p>
        <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
          {JSON.stringify(event.payloadJsonSchema, null, 2)}
        </pre>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Example event input</p>
        <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
          {JSON.stringify(defaultEventExample, null, 2)}
        </pre>
      </div>
    </section>
  );
}

function ProcessorLinks({ processors, title }: { processors: ProcessorDoc[]; title: string }) {
  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-2">
        {processors.map((processor) => (
          <Link
            key={processor.contract.slug}
            to={processor.href}
            className="text-sm text-primary hover:underline"
          >
            {processor.contract.slug}
          </Link>
        ))}
      </div>
    </div>
  );
}

function EventLinks({ events, title }: { events: ProcessorEventDoc[]; title: string }) {
  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((event) => (
            <div key={event.type} className="space-y-1">
              <Link to={event.href} className="text-sm font-medium text-primary hover:underline">
                {event.eventSlug}
              </Link>
              <EventType type={event.type} className="text-xs" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
