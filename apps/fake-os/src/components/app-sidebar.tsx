import { Link, useLocation } from "@tanstack/react-router";
import {
  Plus,
  ServerIcon,
  InfoIcon,
  RadioIcon,
  TerminalSquareIcon,
  WaypointsIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/sidebar";

interface Deployment {
  id: string;
  provider: string;
  slug: string;
}

export function AppSidebar({
  deployments,
  selectedSlug,
}: {
  deployments: Deployment[];
  selectedSlug: string | undefined;
}) {
  const location = useLocation();
  const pathname = location.pathname;

  const selected = selectedSlug ? deployments.find((d) => d.slug === selectedSlug) : undefined;
  const others = selectedSlug ? deployments.filter((d) => d.slug !== selectedSlug) : deployments;

  return (
    <Sidebar className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                F
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">fake-os</span>
                <span className="truncate text-xs">deployments</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {selected && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <span className="block max-w-full truncate font-mono text-xs" title={selected.slug}>
                {selected.slug}
              </span>
            </SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={<Link to="/deployments/$slug" params={{ slug: selected.slug }} />}
                      isActive={pathname === `/deployments/${selected.slug}`}
                    >
                      <InfoIcon className="size-3.5" />
                      Overview
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={
                        <Link to="/deployments/$slug/events" params={{ slug: selected.slug }} />
                      }
                      isActive={pathname === `/deployments/${selected.slug}/events`}
                    >
                      <RadioIcon className="size-3.5" />
                      Logs
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={
                        <Link to="/deployments/$slug/pidnap" params={{ slug: selected.slug }} />
                      }
                      isActive={pathname === `/deployments/${selected.slug}/pidnap`}
                    >
                      <TerminalSquareIcon className="size-3.5" />
                      Pidnap
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      render={
                        <Link to="/deployments/$slug/services" params={{ slug: selected.slug }} />
                      }
                      isActive={pathname === `/deployments/${selected.slug}/services`}
                    >
                      <WaypointsIcon className="size-3.5" />
                      Services
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Deployments</SidebarGroupLabel>
          <SidebarGroupAction render={<Link to="/deployments/new" />} title="New Deployment">
            <Plus />
            <span className="sr-only">New Deployment</span>
          </SidebarGroupAction>
          <SidebarMenu>
            {others.map((deployment) => (
              <SidebarMenuItem key={deployment.id}>
                <SidebarMenuButton
                  render={<Link to="/deployments/$slug" params={{ slug: deployment.slug }} />}
                  isActive={selectedSlug === deployment.slug}
                >
                  <ServerIcon className="size-4 shrink-0" />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={deployment.slug}
                  >
                    {deployment.slug}
                  </span>
                  <span className="text-xs text-muted-foreground">{deployment.provider}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {others.length === 0 && !selected && (
              <SidebarMenuItem>
                <span className="text-xs text-muted-foreground px-2 py-1">No deployments yet</span>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
