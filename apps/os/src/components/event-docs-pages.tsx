import { Link } from "@tanstack/react-router";
import type { EventDoc, ProcessorDoc } from "~/lib/event-docs.ts";

export function EventDocsIndexPage(input: {
  eventDocs: readonly EventDoc[];
  processorDocs: readonly ProcessorDoc[];
}) {
  return (
    <EventDocsShell>
      <header className="space-y-3 border-b px-6 py-8 md:px-10">
        <p className="text-sm font-medium uppercase tracking-normal text-muted-foreground">
          events.iterate.com
        </p>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-normal text-foreground">
          Event type reference
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Public documentation generated from the stream processor contracts in OS.
        </p>
      </header>
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Event types</h2>
          <div className="divide-y rounded-md border">
            {input.eventDocs.map((event) => (
              <Link
                key={event.type}
                to="/docs/streams/processors/$processorSlug/events/$"
                params={event.routeParams}
                className="block px-4 py-3 hover:bg-muted/60"
              >
                <span className="block break-all font-mono text-sm text-foreground">
                  {event.type}
                </span>
                {event.description ? (
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {event.description}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
        <aside className="space-y-3">
          <h2 className="text-sm font-semibold">Processors</h2>
          <div className="divide-y rounded-md border">
            {input.processorDocs.map((processor) => (
              <Link
                key={processor.contractSlug}
                to="/docs/streams/processors/$processorSlug"
                params={processor.routeParams}
                className="block px-4 py-3 hover:bg-muted/60"
              >
                <span className="block font-mono text-sm text-foreground">
                  {processor.contractSlug}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {processor.events.length} owned event{processor.events.length === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </aside>
      </main>
    </EventDocsShell>
  );
}

export function ProcessorOverviewPage({ processor }: { processor: ProcessorDoc }) {
  return (
    <EventDocsShell>
      <EventDocsHeader
        eyebrow="Stream processor"
        title={processor.contractSlug}
        description={processor.description}
      />
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-4">
          <DocSection title="Owned event types">
            {processor.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">This processor owns no event types.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {processor.events.map((event) => (
                  <Link
                    key={event.type}
                    to="/docs/streams/processors/$processorSlug/events/$"
                    params={event.routeParams}
                    className="block px-4 py-3 hover:bg-muted/60"
                  >
                    <span className="block break-all font-mono text-sm">{event.type}</span>
                    {event.description ? (
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {event.description}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            )}
          </DocSection>
          <EventReferenceList title="Consumes" events={processor.consumes} />
        </section>
        <aside className="space-y-4">
          <InfoList
            items={[
              ["Version", processor.version ?? "unversioned"],
              ["Public path", processor.href],
              ["Owned events", String(processor.events.length)],
            ]}
          />
          {processor.dependencies.length === 0 ? null : (
            <DocSection title="Dependencies">
              <div className="space-y-2">
                {processor.dependencies.map((dep) => (
                  <Link
                    key={dep.contractSlug}
                    to="/docs/streams/processors/$processorSlug"
                    params={dep.routeParams}
                    className="block rounded-md border px-3 py-2 font-mono text-sm hover:bg-muted/60"
                  >
                    {dep.contractSlug}
                  </Link>
                ))}
              </div>
            </DocSection>
          )}
        </aside>
      </main>
    </EventDocsShell>
  );
}

export function EventDocPage({ event }: { event: EventDoc }) {
  return (
    <EventDocsShell>
      <EventDocsHeader
        eyebrow="Event type"
        title={event.type}
        description={event.description ?? "No description provided."}
      />
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-6">
          <DocSection title="Payload schema">
            <JsonBlock value={event.payloadJsonSchema} />
          </DocSection>
          {event.examples.length === 0 ? null : (
            <DocSection title="Examples">
              <div className="space-y-4">
                {event.examples.map((example) => (
                  <div key={example.description} className="space-y-2">
                    <p className="text-sm text-muted-foreground">{example.description}</p>
                    <JsonBlock value={example.payload} />
                  </div>
                ))}
              </div>
            </DocSection>
          )}
        </section>
        <aside className="space-y-4">
          <InfoList
            items={[
              ["URL path", event.href],
              ["Processor", event.processor.contractSlug],
              ["Event path", event.eventPath],
            ]}
          />
          <DocSection title="Processor">
            <Link
              to="/docs/streams/processors/$processorSlug"
              params={event.processor.routeParams}
              className="block rounded-md border px-3 py-2 font-mono text-sm hover:bg-muted/60"
            >
              {event.processor.contractSlug}
            </Link>
          </DocSection>
        </aside>
      </main>
    </EventDocsShell>
  );
}

function EventDocsShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}

function EventDocsHeader(input: { description?: string; eyebrow: string; title: string }) {
  return (
    <header className="space-y-3 border-b px-6 py-8 md:px-10">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        events.iterate.com
      </Link>
      <p className="text-sm font-medium uppercase tracking-normal text-muted-foreground">
        {input.eyebrow}
      </p>
      <h1 className="max-w-4xl break-words font-mono text-2xl font-semibold tracking-normal text-foreground">
        {input.title}
      </h1>
      {input.description ? (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{input.description}</p>
      ) : null}
    </header>
  );
}

function DocSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function EventReferenceList(input: {
  events: readonly { href?: string; routeParams?: EventDoc["routeParams"]; type: string }[];
  title: string;
}) {
  return (
    <DocSection title={input.title}>
      {input.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {input.events.map((event) =>
            event.href && event.routeParams ? (
              <Link
                key={event.type}
                to="/docs/streams/processors/$processorSlug/events/$"
                params={event.routeParams}
                className="block break-all px-4 py-3 font-mono text-sm hover:bg-muted/60"
              >
                {event.type}
              </Link>
            ) : (
              <div key={event.type} className="break-all px-4 py-3 font-mono text-sm">
                {event.type}
              </div>
            ),
          )}
        </div>
      )}
    </DocSection>
  );
}

function InfoList({ items }: { items: readonly [string, string][] }) {
  return (
    <dl className="divide-y rounded-md border text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="space-y-1 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-5">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}
