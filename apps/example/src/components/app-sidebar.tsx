import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";

const items = [
  { to: "/debug", label: "Debug" },
  { to: "/log-stream", label: "Log Stream" },
  { to: "/things", label: "Things" },
  { to: "/terminal", label: "Terminal" },
] as const;

export function AppSidebar() {
  return (
    <SidebarShell header={<AppSidebarBrand />}>
      <AppSidebarNav />
    </SidebarShell>
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
