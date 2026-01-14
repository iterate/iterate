import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronLeft,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Agent } from "@server/db/schema.ts";
import type { TmuxSession } from "@server/tmux-control.ts";
import { cn } from "@/lib/utils.ts";
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
import { trpcClient, useTRPC } from "@/integrations/tanstack-query/trpc-client.tsx";
import { HEADER_ACTIONS_ID } from "@/components/header-actions-constants.ts";

interface AppHeaderProps {
  agent?: Agent | null;
  agents?: Agent[];
}

export function AppHeader({ agent, agents = [] }: AppHeaderProps) {
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
    mutationFn: () => trpcClient.resetSession.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listSessions.queryKey() });
      toast.success("Agent reset");
    },
    onError: () => {
      toast.error("Failed to reset agent");
    },
  });

  const stopAgent = useMutation({
    mutationFn: () => trpcClient.stopSession.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listSessions.queryKey() });
      queryClient.removeQueries({ queryKey: ["ensureAgentStarted", agent!.slug] });
      toast.success("Agent stopped");
    },
    onError: () => {
      toast.error("Failed to stop agent");
    },
  });

  const deleteAgent = useMutation({
    mutationFn: () => trpcClient.deleteSession.mutate({ slug: agent!.slug }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.listSessions.queryKey() });
      toast.success("Agent deleted");
    },
    onError: () => {
      toast.error("Failed to delete agent");
    },
  });

  // Determine display name for mobile
  const mobileDisplayName = agent?.slug
    ? agent.slug
    : isNewAgentRoute
      ? "New Agent"
      : isTerminalRoute
        ? "Terminal"
        : isBtopRoute
          ? "System"
          : isAgentRoute
            ? "Agents"
            : "Home";

  return (
    <header
      aria-label="Site header"
      className="flex h-16 shrink-0 items-center border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12"
    >
      <div className="flex w-full items-center justify-between gap-2 px-4">
        {/* Left side - breadcrumbs with max-width constraint */}
        <div className="flex max-w-md items-center gap-2">
          <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />

          {/* Mobile navigation - back button and current location */}
          <div className="flex items-center gap-2 md:hidden">
            {/* Only show back button when not on the agents list (home) */}
            {(agent || isNewAgentRoute || isTerminalRoute || isBtopRoute) && (
              <Link
                to="/agents"
                className="flex items-center text-muted-foreground hover:text-foreground transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Go back"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
            <span className="text-sm font-medium truncate max-w-[200px]">{mobileDisplayName}</span>
          </div>

          {/* Desktop breadcrumbs */}
          <Breadcrumb className="hidden md:flex">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/">iterate</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {(isAgentRoute || isNewAgentRoute) && (
                <>
                  <BreadcrumbSeparator />
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
                  <AgentBreadcrumbDropdown currentAgent={agent} agents={agents} />
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
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Terminal</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
              {isBtopRoute && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>System Utilisation</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Right side - actions without max-width, pushed to far right */}
        <div id={HEADER_ACTIONS_ID} className="flex items-center gap-2">
          {isTerminalRoute && (
            <TerminalShortcutsDropdown
              tmuxSessions={tmuxSessions}
              onCommand={sendTerminalCommand}
            />
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
        </div>
      </div>
    </header>
  );
}

// Dropdown trigger styling - matches apps/os pattern
const DROPDOWN_TRIGGER_CLASSES =
  "flex items-center gap-1 rounded-sm px-1 -mx-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

interface AgentBreadcrumbDropdownProps {
  currentAgent: Agent;
  agents: Agent[];
}

function AgentBreadcrumbDropdown({ currentAgent, agents }: AgentBreadcrumbDropdownProps) {
  const navigate = useNavigate();

  return (
    <BreadcrumbItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${currentAgent.slug}, switch agent`}
            aria-haspopup="menu"
            className={cn(DROPDOWN_TRIGGER_CLASSES, "font-normal text-foreground")}
          >
            <BreadcrumbPage className="pointer-events-none max-w-[150px] truncate sm:max-w-[200px]">
              {currentAgent.slug}
            </BreadcrumbPage>
            <ChevronDownIcon className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {agents.map((agentItem) => {
            const isCurrent = agentItem.slug === currentAgent.slug;
            return (
              <DropdownMenuItem
                key={agentItem.slug}
                className="gap-2"
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => navigate({ to: "/agents/$slug", params: { slug: agentItem.slug } })}
              >
                <div
                  className="flex size-5 items-center justify-center rounded-sm border bg-muted/50"
                  aria-hidden="true"
                >
                  <span className="text-xs font-medium">
                    {agentItem.slug.charAt(0).toUpperCase()}
                  </span>
                </div>
                <span className="truncate">{agentItem.slug}</span>
                {isCurrent && <span className="sr-only">(current)</span>}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-2">
            <Link to="/agents/new" search={{ name: undefined }}>
              <div
                className="flex size-5 items-center justify-center rounded-sm border border-dashed"
                aria-hidden="true"
              >
                <PlusIcon className="size-3" aria-hidden="true" />
              </div>
              <span className="text-muted-foreground">New agent</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
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
