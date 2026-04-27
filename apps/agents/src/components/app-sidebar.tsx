import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import { SidebarThemeSwitcher } from "@iterate-com/ui/components/sidebar-theme-switcher";
import { getOrpcClient } from "~/orpc/client.ts";

const LIST_AGENTS_QUERY_KEY = ["listAgents"] as const;

/**
 * Sidebar listing every agent the auto-subscriber has discovered. Polls
 * every 5s so brand-new agents show up without a refresh; tab-out pauses.
 */
export function AppSidebar() {
  const agentsQuery = useQuery({
    queryKey: LIST_AGENTS_QUERY_KEY,
    queryFn: () => getOrpcClient().listAgents({}),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });

  const agents = agentsQuery.data?.agents ?? [];

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
      <SidebarGroup>
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupContent>
          {agentsQuery.isPending ? (
            <p className="px-2 text-xs text-muted-foreground">Loading…</p>
          ) : agentsQuery.error ? (
            <p className="px-2 text-xs text-destructive">{agentsQuery.error.message}</p>
          ) : agents.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">
              No agents yet — pick a preset and click 🎲 New agent.
            </p>
          ) : (
            <SidebarMenu>
              {agents.map((agent) => (
                <SidebarMenuItem key={agent.streamPath}>
                  <SidebarMenuButton
                    render={<a href={agent.streamViewerUrl} target="_blank" rel="noreferrer" />}
                  >
                    <div className="grid min-w-0 flex-1 text-left leading-tight">
                      <span className="truncate font-medium">{agent.streamPath}</span>
                      <span className="truncate text-xs text-sidebar-foreground/70">
                        {formatDiscoveredAt(agent.discoveredAt)}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarShell>
  );
}

function AppSidebarBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<Link to="/" />}>
          <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg font-semibold">
            Ag
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">Agents</span>
            <span className="truncate text-xs text-sidebar-foreground/70">presets</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Human-friendly "discovered N ago" — second-precision is overkill for a sidebar. */
function formatDiscoveredAt(timestampMs: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
}
