import { Link, useParams, useNavigate } from "@tanstack/react-router";
import { BotIcon, Plus, TerminalIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

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
import type { TmuxSession } from "@/backend/tmux-control.ts";
import { useTRPC } from "@/integrations/trpc/react.ts";
import { trpcClient } from "@/integrations/tanstack-query/trpc-client.ts";

export function AppSidebar({ tmuxSessions }: { tmuxSessions: TmuxSession[] }) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const selectedTmuxSession =
    "tmuxSessionName" in params ? (params.tmuxSessionName as string) : null;

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createSession = useMutation({
    mutationFn: () => trpcClient.createTmuxSession.mutate({}),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: trpc.listTmuxSessions.queryKey() });
      navigate({
        to: "/tmux-sessions/$tmuxSessionName/pty",
        params: { tmuxSessionName: result.name },
      });
    },
  });

  const sortedTmuxSessions = [...tmuxSessions].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
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
                <Link to="/">
                  <BotIcon />
                  <span>Agents</span>
                </Link>
              </SidebarMenuButton>
              <SidebarMenuAction
                onClick={() => createSession.mutate()}
                disabled={createSession.isPending}
              >
                <Plus />
                <span className="sr-only">New Agent</span>
              </SidebarMenuAction>
              <SidebarMenuSub>
                {sortedTmuxSessions.map((tmuxSession) => (
                  <SidebarMenuSubItem key={tmuxSession.name}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={selectedTmuxSession === tmuxSession.name}
                    >
                      <Link
                        to="/tmux-sessions/$tmuxSessionName/pty"
                        params={{ tmuxSessionName: tmuxSession.name }}
                      >
                        <TerminalIcon className="size-3" />
                        <span>{tmuxSession.name}</span>
                        {tmuxSession.attached && (
                          <span className="ml-auto text-xs text-muted-foreground">attached</span>
                        )}
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
                {sortedTmuxSessions.length === 0 && (
                  <SidebarMenuSubItem>
                    <span className="text-xs text-muted-foreground px-2 py-1">No agents yet</span>
                  </SidebarMenuSubItem>
                )}
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
