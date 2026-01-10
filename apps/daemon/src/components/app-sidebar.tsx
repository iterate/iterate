import { Link, useParams } from "@tanstack/react-router";
import { BotIcon, Plus } from "lucide-react";

import { ThemeSwitcher } from "./theme-switcher.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar.tsx";
import type { AgentInfo } from "@/hooks/use-stream-reducer.tsx";

export function AppSidebar({ agents }: { agents: AgentInfo[] }) {
  const params = useParams({ strict: false });
  const selectedAgent = "agentId" in params ? (params.agentId as string) : null;

  const sortedAgents = [...agents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <img src="/logo.svg" alt="𝑖" className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">iterate</span>
                  <span className="truncate text-xs">daemon</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Agents" asChild>
                <Link to="/agents">
                  <BotIcon />
                  <span>Agents</span>
                </Link>
              </SidebarMenuButton>
              <SidebarMenuAction asChild>
                <Link to="/new-agent">
                  <Plus />
                  <span className="sr-only">New Agent</span>
                </Link>
              </SidebarMenuAction>
              <SidebarMenuSub>
                {sortedAgents.map((agent) => (
                  <SidebarMenuSubItem key={agent.path}>
                    <SidebarMenuSubButton asChild isActive={selectedAgent === agent.path}>
                      <Link to="/agents/$agentId" params={{ agentId: agent.path }}>
                        <span>{agent.path}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <ThemeSwitcher />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
