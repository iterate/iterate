import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import { StreamsSidebar } from "~/components/streams-sidebar.tsx";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

export function AppSidebar() {
  return (
    <SidebarShell header={<AppSidebarBrand />}>
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
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          render={<Link to="/streams/" search={defaultStreamViewSearch} />}
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

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                render={
                  item.to === "/streams/" ? (
                    <Link to={item.to} search={defaultStreamViewSearch} />
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
