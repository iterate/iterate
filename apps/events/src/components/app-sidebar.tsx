import { Link, useMatchRoute, useSearch } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import { SidebarThemeSwitcher } from "@iterate-com/ui/components/sidebar-theme-switcher";
import { StreamsSidebar } from "~/components/streams-sidebar.tsx";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

type StreamLinkSearch = {
  composer?: string;
  event?: number;
  renderer?: string;
  [key: string]: unknown;
};

export function AppSidebar() {
  return (
    <SidebarShell
      header={<AppSidebarBrand />}
      footer={
        <>
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
  { to: "/secrets/", label: "Env vars" },
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
