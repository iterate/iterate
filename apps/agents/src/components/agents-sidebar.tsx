// The sidebar, apps/os's app shell at this page's size: the project, "New agent", the project's
// agents by path, and the account row. An agent IS its path (`/agents/...`); "New agent" births one
// at a generated path and the page opens it — no name to type.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BotIcon, ChevronsUpDownIcon, LogOutIcon, SquarePenIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { IterateMark } from "@iterate-com/ui/components/iterate-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";

export function AgentsSidebar({
  projects,
  project,
  agents,
  agent,
  account,
  onCreate,
}: {
  projects: { id: string }[];
  project: string;
  agents: { path: string }[];
  agent: string | undefined;
  account: string;
  /** Births an agent at a fresh path; the page navigates to it once it exists. */
  onCreate: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      await onCreate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {projects.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton size="lg" className="data-[popup-open]:bg-sidebar-accent" />
                  }
                >
                  <IterateMark className="size-8 shrink-0" />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">Agents</span>
                    <span className="truncate text-xs text-muted-foreground">{project}</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
                  {projects.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      render={<Link to="/agents" search={{ project: item.id }} />}
                    >
                      {item.id}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton size="lg" render={<div />}>
                <IterateMark className="size-8 shrink-0" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Agents</span>
                  <span className="truncate text-xs text-muted-foreground">{project}</span>
                </div>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  onClick={() => void create()}
                  disabled={creating}
                  tooltip="New agent"
                >
                  <SquarePenIcon />
                  <span>{creating ? "Creating…" : "New agent"}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No agents yet.</p>
              ) : null}
              {agents.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    isActive={item.path === agent}
                    tooltip={item.path}
                    render={<Link to="/agents" search={{ project, agent: item.path }} />}
                  >
                    <BotIcon />
                    <span className="truncate font-mono text-xs">{item.path}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <form method="post" action="/.auth/logout">
              <SidebarMenuButton type="submit" tooltip="Log out">
                <LogOutIcon />
                <span className="truncate">{account}</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
