import { Link, useLocation } from "@tanstack/react-router";
import { BookOpenText, Database, Globe, Settings2, Waypoints } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { Badge } from "@iterate-com/ui/components/badge";

const sections = [
  {
    label: "Registry",
    items: [
      { to: "/routes", label: "Routes", icon: Globe, exact: false },
      { to: "/docs", label: "Docs", icon: BookOpenText, exact: true },
      { to: "/db", label: "DB", icon: Database, exact: true },
      { to: "/config", label: "Config", icon: Settings2, exact: true },
      { to: "/caddy", label: "Caddy", icon: Waypoints, exact: true },
    ],
  },
];

function isActivePath(pathname: string, to: string, exact: boolean) {
  if (exact) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useLocation().pathname;

  return (
    <Sidebar className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/routes">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                  R
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">registry</span>
                  <span className="truncate text-xs">control plane</span>
                </div>
                <Badge variant="secondary">start</Badge>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild isActive={isActivePath(pathname, item.to, item.exact)}>
                    <Link to={item.to}>
                      <item.icon className="size-4 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
