import { Link, useParams, useNavigate, useLocation } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, MoreHorizontal, ArchiveIcon, TerminalIcon, ActivityIcon } from "lucide-react";

import type { Agent } from "@server/db/schema.ts";
import { ThemeSwitcher } from "./theme-switcher.tsx";
import { useTRPC } from "@/integrations/tanstack-query/trpc-client.tsx";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
import { AgentTypeIcon } from "@/components/agent-type-icons.tsx";

const MAX_SIDEBAR_AGENTS = 10;

export function AppSidebar({ agents }: { agents: Agent[] }) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const location = useLocation();
  const selectedSlug = "slug" in params ? (params.slug as string) : null;
  const currentPath = location.pathname;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const archiveAgentMutation = useMutation(
    trpc.archiveAgent.mutationOptions({
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
        if (variables.slug === selectedSlug) {
          navigate({ to: "/agents" });
        }
      },
    }),
  );

  const sortedAgents = [...agents].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  const visibleAgents = sortedAgents.slice(0, MAX_SIDEBAR_AGENTS);
  const hasMore = sortedAgents.length > MAX_SIDEBAR_AGENTS;

  return (
    <>
      <Sidebar className="border-r-0">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link to="/">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg">
                    <img src="/logo.svg" alt="𝑖" className="size-8" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">iterate</span>
                    <span className="truncate text-xs">agents</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Agents</SidebarGroupLabel>
            <SidebarGroupAction asChild title="New Agent">
              <Link to="/agents/new" search={{ name: undefined }}>
                <Plus />
                <span className="sr-only">New Agent</span>
              </Link>
            </SidebarGroupAction>
            <SidebarMenu>
              {visibleAgents.map((agent) => (
                <SidebarMenuItem key={agent.id}>
                  <SidebarMenuButton asChild isActive={selectedSlug === agent.slug}>
                    <Link to="/agents/$slug" params={{ slug: agent.slug }}>
                      <AgentTypeIcon type={agent.harnessType} className="size-4 shrink-0" />
                      <span className="flex-1 truncate">{agent.slug}</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    showOnHover
                    onClick={(e) => {
                      e.preventDefault();
                      archiveAgentMutation.mutate({ slug: agent.slug });
                    }}
                    disabled={archiveAgentMutation.isPending}
                    title="Archive agent"
                  >
                    <ArchiveIcon className="size-3" />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
              {visibleAgents.length === 0 && (
                <SidebarMenuItem>
                  <span className="text-xs text-muted-foreground px-2 py-1">No agents yet</span>
                </SidebarMenuItem>
              )}
              {hasMore && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className="text-sidebar-foreground/70">
                    <Link to="/agents">
                      <MoreHorizontal className="text-sidebar-foreground/70" />
                      <span>View all</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Tools</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentPath === "/terminal"}>
                  <Link to="/terminal">
                    <TerminalIcon className="size-4" />
                    <span>Terminal</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentPath === "/btop"}>
                  <Link to="/btop">
                    <ActivityIcon className="size-4" />
                    <span>System Utilisation (btop)</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <ThemeSwitcher />
        </SidebarFooter>
      </Sidebar>
    </>
  );
}
