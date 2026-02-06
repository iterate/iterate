import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronLeft, PlusIcon } from "lucide-react";

import type { SerializedAgent } from "@server/trpc/router.ts";
import { cn } from "@/lib/utils.ts";
import { Separator } from "@/components/ui/separator.tsx";
import { SidebarTrigger } from "@/components/ui/sidebar.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { HEADER_ACTIONS_ID } from "@/components/header-actions-constants.ts";

interface AppHeaderProps {
  agent?: SerializedAgent | null;
  agents?: SerializedAgent[];
}

export function AppHeader({ agent, agents = [] }: AppHeaderProps) {
  const location = useLocation();

  const isAgentRoute = location.pathname.startsWith("/agents/");
  const isNewAgentRoute = location.pathname === "/agents/new";
  const isTerminalRoute = location.pathname === "/terminal";

  // Determine display name for mobile
  const mobileDisplayName = agent?.path
    ? agent.path
    : isNewAgentRoute
      ? "New Agent"
      : isTerminalRoute
        ? "Terminal"
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
            {(agent || isNewAgentRoute || isTerminalRoute) && (
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
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Right side - actions without max-width, pushed to far right */}
        <div id={HEADER_ACTIONS_ID} className="flex items-center gap-2" />
      </div>
    </header>
  );
}

// Dropdown trigger styling - matches apps/os pattern
const DROPDOWN_TRIGGER_CLASSES =
  "flex items-center gap-1 rounded-sm px-1 -mx-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

interface AgentBreadcrumbDropdownProps {
  currentAgent: SerializedAgent;
  agents: SerializedAgent[];
}

function AgentBreadcrumbDropdown({ currentAgent, agents }: AgentBreadcrumbDropdownProps) {
  const navigate = useNavigate();

  return (
    <BreadcrumbItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${currentAgent.path}, switch agent`}
            aria-haspopup="menu"
            className={cn(DROPDOWN_TRIGGER_CLASSES, "font-normal text-foreground")}
          >
            <BreadcrumbPage className="pointer-events-none max-w-[150px] truncate sm:max-w-[200px]">
              {currentAgent.path}
            </BreadcrumbPage>
            <ChevronDownIcon className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {agents.map((agentItem) => {
            const isCurrent = agentItem.path === currentAgent.path;
            return (
              <DropdownMenuItem
                key={agentItem.path}
                className="gap-2"
                aria-current={isCurrent ? "true" : undefined}
                onClick={() =>
                  navigate({
                    to: "/agents/$slug",
                    params: { slug: encodeURIComponent(agentItem.path) },
                  })
                }
              >
                <div
                  className="flex size-5 items-center justify-center rounded-sm border bg-muted/50"
                  aria-hidden="true"
                >
                  <span className="text-xs font-medium">
                    {agentItem.path.charAt(1).toUpperCase() || "A"}
                  </span>
                </div>
                <span className="truncate">{agentItem.path}</span>
                {isCurrent && <span className="sr-only">(current)</span>}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-2">
            <Link to="/agents/new" search={{ path: undefined }}>
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
