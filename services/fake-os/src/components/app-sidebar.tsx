import { Link } from "@tanstack/react-router";
import { Plus, ServerIcon } from "lucide-react";
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
  return (
    <Sidebar className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                  F
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">fake-os</span>
                  <span className="truncate text-xs">deployments</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Deployments</SidebarGroupLabel>
          <SidebarGroupAction asChild title="New Deployment">
            <Link to="/deployments/new">
              <Plus />
              <span className="sr-only">New Deployment</span>
            </Link>
          </SidebarGroupAction>
          <SidebarMenu>
            {deployments.map((deployment) => (
              <SidebarMenuItem key={deployment.id}>
                <SidebarMenuButton asChild isActive={selectedSlug === deployment.slug}>
                  <Link to="/deployments/$slug" params={{ slug: deployment.slug }}>
                    <ServerIcon className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{deployment.slug}</span>
                    <span className="text-xs text-muted-foreground">{deployment.provider}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {deployments.length === 0 && (
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
