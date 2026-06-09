import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@iterate-com/ui/components/sidebar";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";

const items = [
  { to: "/debug", label: "Debug" },
  { to: "/confetti", label: "Confetti" },
  { to: "/durable-objects", label: "Durable Objects" },
  { to: "/log-stream", label: "Log Stream" },
  { to: "/things", label: "Things" },
] as const;

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <AppSidebarBrand />
      </SidebarHeader>
      <SidebarContent>
        <AppSidebarNav />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function AppSidebarBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<Link to="/debug" />}>
          <IterateLogo className="size-8 rounded-lg" />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">example</span>
            <span className="text-sidebar-foreground/70 truncate text-xs">tanstack start</span>
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
                render={<Link to={item.to} />}
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
