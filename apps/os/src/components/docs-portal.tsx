import { Link } from "@tanstack/react-router";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Input } from "@iterate-com/ui/components/input";
import { Separator } from "@iterate-com/ui/components/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@iterate-com/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  eventDocs,
  getEventDocByType,
  processorDocs,
  type EventDoc,
  type EventReferenceDoc,
  type ProcessorDoc,
} from "~/lib/event-docs.ts";

export function DocsHomePage() {
  return (
    <DocsPortalChrome>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Docs</p>
          <h1 className="text-2xl font-semibold">Iterate OS docs</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Static server-rendered documentation for OS runtime concepts.
          </p>
        </div>
        <Link
          to="/docs/streams/processors"
          className="block max-w-xl rounded-md border bg-card p-4 transition-colors hover:bg-accent/50"
        >
          <div className="space-y-1">
            <h2 className="font-medium">Stream Processors</h2>
            <p className="text-sm text-muted-foreground">
              Processor contracts, event type URLs, payload schemas, and examples.
            </p>
          </div>
        </Link>
      </section>
    </DocsPortalChrome>
  );
}

export function StreamProcessorsIndexPage() {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProcessors = useMemo(() => {
    if (!normalizedQuery) return processorDocs;
    return processorDocs.filter(
      (processor) =>
        processor.slug.toLowerCase().includes(normalizedQuery) ||
        processor.contract.description?.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  return (
    <DocsPortalChrome>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">Stream Processors</p>
            <h1 className="text-2xl font-semibold">Processor contracts</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              The contract catalog behind the resolvable `events.iterate.com` event type URLs.
            </p>
          </div>
          <div className="relative w-full md:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search stream processors"
              className="pl-8"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search processors"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Processors" value={processorDocs.length} />
          <Metric label="Event types" value={eventDocs.length} />
          <Metric
            label="Side-effect processors"
            value={processorDocs.filter((processor) => processor.events.length === 0).length}
          />
          <Metric
            label="Wildcard consumers"
            value={
              processorDocs.filter((processor) => processor.contract.consumes.includes("*")).length
            }
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {visibleProcessors.map((processor) => (
            <ProcessorSummary key={processor.slug} processor={processor} />
          ))}
        </div>
      </section>
    </DocsPortalChrome>
  );
}

export function ProcessorOverviewPage({ processor }: { processor: ProcessorDoc }) {
  return (
    <DocsPortalChrome processor={processor}>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Stream Processor</p>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{processor.slug}</h1>
            {processor.contract.version ? (
              <Badge variant="secondary">{processor.contract.version}</Badge>
            ) : null}
          </div>
          {processor.contract.slug !== processor.slug ? (
            <p className="text-xs text-muted-foreground">
              Contract slug: {processor.contract.slug}
            </p>
          ) : null}
          {processor.contract.description ? (
            <p className="text-sm text-muted-foreground">{processor.contract.description}</p>
          ) : null}
        </div>

        {processor.processorDeps.length > 0 ? (
          <ProcessorLinks title="Processor deps" processors={processor.processorDeps} />
        ) : null}

        <EventReferenceLinks title="Consumes" events={processor.consumes} />
        <UnresolvedEventReferences title="External consumes" types={processor.unresolvedConsumes} />
        <EventReferenceLinks
          title="Emits"
          events={(processor.contract.emits ?? [])
            .map((type) => getEventDocByType(type))
            .filter((event): event is EventDoc => event != null)}
        />
        <UnresolvedEventReferences title="External emits" types={processor.unresolvedEmits} />
        <EventLinks title="Owned events" events={processor.events} />
      </section>
    </DocsPortalChrome>
  );
}

export function EventDocPage({ event }: { event: EventDoc }) {
  const eventExamples =
    event.examples.length > 0
      ? event.examples.map((example) => ({
          description: example.description,
          event: { type: event.type, payload: example.payload },
        }))
      : [{ description: "Minimal event input", event: { type: event.type, payload: {} } }];

  return (
    <DocsPortalChrome event={event} processor={event.processor}>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Event Type</p>
          <h1 className="text-xl font-semibold">
            <EventType type={event.type} link={false} />
          </h1>
          {event.description ? (
            <p className="text-sm text-muted-foreground">{event.description}</p>
          ) : null}
        </div>
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Payload JSON schema</h2>
          <CodeBlock value={event.payloadJsonSchema} className="max-h-[32rem]" />
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-medium">
            {eventExamples.length === 1 ? "Example event input" : "Example event inputs"}
          </h2>
          <div className="space-y-3">
            {eventExamples.map((example) => (
              <div key={example.description} className="space-y-2">
                <p className="text-sm text-muted-foreground">{example.description}</p>
                <CodeBlock value={example.event} />
              </div>
            ))}
          </div>
        </section>
      </section>
    </DocsPortalChrome>
  );
}

function DocsPortalChrome({
  children,
  event,
  processor,
}: {
  children: ReactNode;
  event?: EventDoc;
  processor?: ProcessorDoc;
}) {
  return (
    <SidebarProvider
      defaultOpen
      className="h-svh"
      style={{ "--sidebar-width": "22rem" } as CSSProperties}
    >
      <DocsSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <DocsBreadcrumbs event={event} processor={processor} />
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function DocsSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/docs" />}>
              <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-md font-semibold">
                OS
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Docs</span>
                <span className="truncate text-xs text-sidebar-foreground/70">OS reference</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Stream Processors</SidebarGroupLabel>
          <SidebarGroupContent className="overflow-x-auto">
            <SidebarMenu className="min-w-max">
              {processorDocs.map((processor) => (
                <DocsProcessorNavItem key={processor.slug} processor={processor} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function DocsProcessorNavItem({ processor }: { processor: ProcessorDoc }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link to={processor.href} />}>
        <span>{processor.slug}</span>
      </SidebarMenuButton>
      {processor.events.length > 0 ? (
        <SidebarMenuSub className="mx-0 min-w-max border-l pl-3 pr-0">
          {processor.events.map((event) => (
            <SidebarMenuSubItem key={event.type}>
              <SidebarMenuSubButton
                render={<Link to={event.href} title={event.type} />}
                className="h-6 font-mono text-[11px]"
              >
                <span className="truncate">{event.eventSlug}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

function DocsBreadcrumbs({ event, processor }: { event?: EventDoc; processor?: ProcessorDoc }) {
  return (
    <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-2 text-sm">
      <Link to="/docs" className="shrink-0 text-muted-foreground hover:text-foreground">
        Docs
      </Link>
      <span className="shrink-0 text-muted-foreground">/</span>
      <Link
        to="/docs/streams/processors"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        Stream Processors
      </Link>
      {processor ? (
        <>
          <span className="shrink-0 text-muted-foreground">/</span>
          <Link to={processor.href} className="min-w-0 truncate hover:underline">
            {processor.slug}
          </Link>
        </>
      ) : null}
      {event ? (
        <>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 truncate font-mono text-xs">{event.eventSlug}</span>
        </>
      ) : null}
    </nav>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function ProcessorSummary({ processor }: { processor: ProcessorDoc }) {
  return (
    <Link to={processor.href} className="block rounded-md border bg-card p-4 hover:bg-accent/50">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-medium">{processor.slug}</p>
          <Badge variant="outline">{processor.events.length} events</Badge>
        </div>
        {processor.contract.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {processor.contract.description}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function ProcessorLinks({ processors, title }: { processors: ProcessorDoc[]; title: string }) {
  return (
    <DocPanel title={title}>
      <div className="flex flex-col gap-2">
        {processors.map((processor) => (
          <Link
            key={processor.slug}
            to={processor.href}
            className="text-sm text-primary hover:underline"
          >
            {processor.slug}
          </Link>
        ))}
      </div>
    </DocPanel>
  );
}

function EventLinks({ events, title }: { events: EventDoc[]; title: string }) {
  return (
    <DocPanel title={title}>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((event) => (
            <div key={event.type} className="min-w-0 space-y-1">
              <EventType type={event.type} className="text-sm" />
              {event.description ? (
                <p className="text-sm text-muted-foreground">{event.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </DocPanel>
  );
}

function EventReferenceLinks({ events, title }: { events: EventReferenceDoc[]; title: string }) {
  return (
    <DocPanel title={title}>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((event) => (
            <EventType key={event.type} type={event.type} className="text-sm" />
          ))}
        </div>
      )}
    </DocPanel>
  );
}

function UnresolvedEventReferences({ title, types }: { title: string; types: readonly string[] }) {
  if (types.length === 0) return null;

  return (
    <DocPanel title={title}>
      <div className="flex flex-col gap-2">
        {types.map((type) => (
          <EventType key={type} type={type} className="text-sm" link={false} />
        ))}
      </div>
    </DocPanel>
  );
}

function DocPanel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-2 rounded-md border bg-card p-4">
      <h2 className="text-xs font-medium uppercase text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function EventType({
  type,
  className,
  link = true,
}: {
  type: string;
  className?: string;
  link?: boolean;
}) {
  const label = (
    <StreamEventType
      type={type}
      getHref={link ? (eventType) => getEventDocByType(eventType)?.href : undefined}
      renderLink={({ href, className: linkClassName, children }) => (
        <Link to={href} className={linkClassName}>
          {children}
        </Link>
      )}
      className={cn("max-w-full", className)}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0 max-w-full" />}>
        {label}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <p className="font-mono text-xs wrap-break-word">{type}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function CodeBlock({ className, value }: { className?: string; value: unknown }) {
  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border bg-muted p-3 font-mono text-xs",
        className,
      )}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
