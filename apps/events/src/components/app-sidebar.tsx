import { useEffect, useState } from "react";
import { Link, useMatchRoute, useSearch } from "@tanstack/react-router";
import { ProjectSlug, type ProjectSlug as ProjectSlugValue } from "@iterate-com/events-contract";
import { Button } from "@iterate-com/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import { SidebarThemeSwitcher } from "@iterate-com/ui/components/sidebar-theme-switcher";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamsSidebar } from "~/components/streams-sidebar.tsx";
import { getProjectUrl } from "~/lib/project-slug.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

type StreamLinkSearch = {
  composer?: string;
  event?: number;
  renderer?: string;
  [key: string]: unknown;
};

export function AppSidebar({ projectSlug }: { projectSlug: ProjectSlugValue }) {
  return (
    <SidebarShell
      header={<AppSidebarBrand />}
      footer={
        <>
          <AppSidebarProjectSlugFooter projectSlug={projectSlug} />
          <SidebarSeparator />
          <SidebarThemeSwitcher />
        </>
      }
    >
      <AppSidebarNav />
      <StreamsSidebar />
    </SidebarShell>
  );
}

const items = [
  { to: "/secrets/", label: "Secrets" },
  { to: "/streams/", label: "Streams" },
] as const;

function AppSidebarBrand() {
  const search = useSearch({ strict: false });
  const currentRenderer =
    "renderer" in search && typeof search.renderer === "string"
      ? search.renderer
      : defaultStreamViewSearch.renderer;
  const currentComposer =
    "composer" in search && typeof search.composer === "string"
      ? search.composer
      : defaultStreamViewSearch.composer;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          render={
            <Link
              to="/streams/"
              search={(previous: StreamLinkSearch) => ({
                ...previous,
                event: defaultStreamViewSearch.event,
                renderer: currentRenderer,
                composer: currentComposer,
              })}
            />
          }
        >
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg font-semibold">
            Ev
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">Events</span>
            <span className="text-sidebar-foreground/70 truncate text-xs">durable streams</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebarNav() {
  const matchRoute = useMatchRoute();
  const search = useSearch({ strict: false });
  const currentRenderer =
    "renderer" in search && typeof search.renderer === "string"
      ? search.renderer
      : defaultStreamViewSearch.renderer;
  const currentComposer =
    "composer" in search && typeof search.composer === "string"
      ? search.composer
      : defaultStreamViewSearch.composer;

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                render={
                  item.to === "/streams/" ? (
                    <Link
                      to={item.to}
                      search={(previous: StreamLinkSearch) => ({
                        ...previous,
                        event: defaultStreamViewSearch.event,
                        renderer: currentRenderer,
                        composer: currentComposer,
                      })}
                    />
                  ) : (
                    <Link to={item.to} />
                  )
                }
                isActive={Boolean(matchRoute({ to: item.to, fuzzy: true }))}
              >
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function AppSidebarProjectSlugFooter({ projectSlug }: { projectSlug: ProjectSlugValue }) {
  const [value, setValue] = useState(projectSlug);

  useEffect(() => {
    setValue(projectSlug);
  }, [projectSlug]);

  function submitProjectSlug() {
    const parsed = ProjectSlug.safeParse(value.trim());
    if (!parsed.success) {
      toast.error("Project slug must be a non-empty string up to 255 characters.");
      return;
    }

    const nextUrl = getProjectUrl({
      currentUrl: window.location.href,
      projectSlug: parsed.data,
    });
    window.location.assign(nextUrl.toString());
  }

  return (
    <form
      className="flex flex-col gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submitProjectSlug();
      }}
    >
      <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Project slug
      </div>
      <SidebarInput
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder="public"
      />
      <Button type="submit" size="sm" className="w-full">
        Apply
      </Button>
    </form>
  );
}
