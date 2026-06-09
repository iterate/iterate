import { Link, useMatchRoute } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
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
  SidebarRail,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@iterate-com/ui/components/sidebar";
import type { ProcessorDoc, ProcessorEventDoc } from "~/lib/processor-docs.ts";
import { processorDocs } from "~/lib/processor-docs.ts";

export function DocsChrome({
  children,
  event,
  processor,
}: {
  children: ReactNode;
  event?: ProcessorEventDoc;
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
        <DocsSidebarBrand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Processors</SidebarGroupLabel>
          <SidebarGroupContent className="overflow-x-auto">
            <SidebarMenu className="min-w-max">
              {processorDocs.map((processor) => (
                <DocsProcessorNavItem key={processor.contract.slug} processor={processor} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function DocsSidebarBrand() {
  const matchRoute = useMatchRoute();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          render={<Link to="/docs" />}
          isActive={Boolean(matchRoute({ to: "/docs" }))}
        >
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg font-semibold">
            Ev
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">Event docs</span>
            <span className="text-sidebar-foreground/70 truncate text-xs">
              processors and event types
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function DocsProcessorNavItem({ processor }: { processor: ProcessorDoc }) {
  const matchRoute = useMatchRoute();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to={processor.href} />}
        isActive={Boolean(matchRoute({ to: processor.href, fuzzy: true }))}
      >
        <span>{processor.contract.slug}</span>
      </SidebarMenuButton>
      <SidebarMenuSub className="mx-0 min-w-max border-l pl-3 pr-0">
        {processor.events.map((event) => (
          <SidebarMenuSubItem key={event.type}>
            <SidebarMenuSubButton
              render={<Link to={event.href} title={event.type} />}
              isActive={Boolean(matchRoute({ to: event.href }))}
              className="h-6 font-mono text-[11px]"
            >
              <span className="truncate">{event.eventSlug}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
}

function DocsBreadcrumbs({
  event,
  processor,
}: {
  event?: ProcessorEventDoc;
  processor?: ProcessorDoc;
}) {
  return (
    <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-2 text-sm">
      <Link to="/docs" className="shrink-0 text-muted-foreground hover:text-foreground">
        Docs
      </Link>
      {processor ? (
        <>
          <span className="shrink-0 text-muted-foreground">/</span>
          <Link to={processor.href} className="min-w-0 truncate hover:underline">
            {processor.contract.slug}
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
