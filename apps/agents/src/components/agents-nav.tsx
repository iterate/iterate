// The sidebar's body for this app (the frame around it is packages/ui's AppShell): "New agent" and
// the project's agents by path. An agent IS its path (`/agents/...`); "New agent" births one at a
// generated path and the page opens it — no name to type.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BotIcon, SquarePenIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";

export function AgentsNav({
  slug,
  agents,
  agent,
  onCreate,
  installed,
}: {
  /** the project's slug — its URL (`/projects/<slug>`) */
  slug: string;
  installed: boolean;
  agents: { path: string }[];
  agent: string | undefined;
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
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                onClick={() => void create()}
                disabled={creating}
                tooltip={installed ? "New agent" : "Install agents"}
              >
                <SquarePenIcon />
                <span>
                  {creating
                    ? installed
                      ? "Creating…"
                      : "Installing…"
                    : installed
                      ? "New agent"
                      : "Install agents"}
                </span>
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
                  render={
                    <Link to="/projects/$slug" params={{ slug }} search={{ agent: item.path }} />
                  }
                >
                  <BotIcon />
                  <span className="truncate font-mono text-xs">{item.path}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
