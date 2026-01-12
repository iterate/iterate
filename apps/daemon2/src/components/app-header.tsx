import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, RotateCcwIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Separator } from "@/components/ui/separator.tsx";
import { SidebarTrigger } from "@/components/ui/sidebar.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { trpcClient } from "@/integrations/tanstack-query/trpc-client.ts";
import { useTRPC } from "@/integrations/trpc/react.ts";
import type { Agent } from "@/db/schema.ts";
import type { TmuxSession } from "@/backend/tmux-control.ts";

interface AppHeaderProps {
  agent?: Agent | null;
}

export function AppHeader({ agent }: AppHeaderProps) {
  const location = useLocation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const isAgentRoute = location.pathname.startsWith("/agents/");
  const isNewAgentRoute = location.pathname === "/agents/new";
  const isTerminalRoute = location.pathname === "/terminal";
  const isBtopRoute = location.pathname === "/btop";

  const { data: tmuxSessions = [] } = useQuery({
    ...trpc.listTmuxSessions.queryOptions(),
    enabled: isTerminalRoute,
  });

  const sendTerminalCommand = (command: string) => {
    window.dispatchEvent(new CustomEvent("terminal:send", { detail: command + "\n" }));
  };

  const resetAgent = useMutation({
    mutationFn: () => trpcClient.resetAgent.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      toast.success("Agent reset");
    },
    onError: () => {
      toast.error("Failed to reset agent");
    },
  });

  const stopAgent = useMutation({
    mutationFn: () => trpcClient.stopAgent.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      queryClient.removeQueries({ queryKey: ["ensureAgentStarted", agent!.slug] });
      toast.success("Agent stopped");
    },
    onError: () => {
      toast.error("Failed to stop agent");
    },
  });

  const deleteAgent = useMutation({
    mutationFn: () => trpcClient.deleteAgent.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listAgents.queryKey() });
      toast.success("Agent deleted");
    },
    onError: () => {
      toast.error("Failed to delete agent");
    },
  });

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink asChild>
                <Link to="/">iterate</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {(isAgentRoute || isNewAgentRoute) && (
              <>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  {agent || isNewAgentRoute ? (
                    <BreadcrumbLink asChild>
                      <Link to="/agents">Agents</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Agents</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            )}
            {agent && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[150px] truncate sm:max-w-[200px]">
                    {agent.slug}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
            {isNewAgentRoute && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>New</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
            {isTerminalRoute && (
              <>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Terminal</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
            {isBtopRoute && (
              <>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>System Utilisation</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {isTerminalRoute && (
        <TerminalShortcutsDropdown tmuxSessions={tmuxSessions} onCommand={sendTerminalCommand} />
      )}
      {agent && (
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => resetAgent.mutate()}
                disabled={resetAgent.isPending}
              >
                <RotateCcwIcon className="size-4" />
                <span className="sr-only">Reset Agent</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset agent session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => stopAgent.mutate()}
                disabled={stopAgent.isPending || agent.status !== "running"}
              >
                <SquareIcon className="size-4" />
                <span className="sr-only">Stop Agent</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop agent</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteAgent.mutate()}
                disabled={deleteAgent.isPending}
              >
                <Trash2Icon className="size-4" />
                <span className="sr-only">Delete Agent</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete agent</TooltipContent>
          </Tooltip>
        </div>
      )}
    </header>
  );
}

interface TerminalShortcut {
  command: string;
  description: string;
  placeholders?: Array<{ name: string; label: string }>;
}

const TERMINAL_SHORTCUTS: TerminalShortcut[] = [
  {
    command: "tmux list-sessions",
    description: "List all active tmux sessions",
  },
  {
    command: "tmux attach -t {session}",
    description: "Attach to a tmux session by name",
    placeholders: [{ name: "session", label: "Session name" }],
  },
  {
    command: "tmux new-session -s {name}",
    description: "Create a new tmux session",
    placeholders: [{ name: "name", label: "New session name" }],
  },
  {
    command: "tmux kill-session -t {session}",
    description: "Kill a tmux session",
    placeholders: [{ name: "session", label: "Session name to kill" }],
  },
];

interface TerminalShortcutsDropdownProps {
  tmuxSessions: TmuxSession[];
  onCommand: (command: string) => void;
}

function TerminalShortcutsDropdown({ tmuxSessions, onCommand }: TerminalShortcutsDropdownProps) {
  const executeShortcut = (shortcut: TerminalShortcut) => {
    let command = shortcut.command;

    if (shortcut.placeholders) {
      for (const placeholder of shortcut.placeholders) {
        const value = window.prompt(placeholder.label);
        if (value === null) return;
        command = command.replace(`{${placeholder.name}}`, value);
      }
    }

    onCommand(command);
  };

  const executeSessionAttach = (sessionName: string) => {
    onCommand(`tmux attach -t ${sessionName}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Shortcuts
          <ChevronDownIcon className="ml-1 size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Commands</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TERMINAL_SHORTCUTS.map((shortcut) => (
          <DropdownMenuItem
            key={shortcut.command}
            onClick={() => executeShortcut(shortcut)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <code className="font-mono text-xs">{shortcut.command}</code>
            <span className="text-xs text-muted-foreground">{shortcut.description}</span>
          </DropdownMenuItem>
        ))}
        {tmuxSessions.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Active Sessions</DropdownMenuLabel>
            {tmuxSessions.map((session) => (
              <DropdownMenuItem
                key={session.name}
                onClick={() => executeSessionAttach(session.name)}
                className="flex flex-col items-start gap-0.5 py-2"
              >
                <code className="font-mono text-xs">tmux attach -t {session.name}</code>
                <span className="text-xs text-muted-foreground">
                  Attach to session ({session.windows} window{session.windows !== 1 ? "s" : ""})
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
