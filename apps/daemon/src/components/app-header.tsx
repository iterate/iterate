import { Link, useLocation } from "@tanstack/react-router";
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
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Label } from "@/components/ui/label.tsx";
import { useRawMode } from "@/hooks/use-raw-mode.ts";

interface AppHeaderProps {
  agentId?: string;
}

export function AppHeader({ agentId }: AppHeaderProps) {
  const location = useLocation();
  const { rawMode, setRawMode, rawEventsCount } = useRawMode();

  const isPtyRoute = agentId && location.pathname.endsWith("/pty");
  const isChatRoute = agentId && !isPtyRoute;
  const isAgentsRoute = location.pathname.startsWith("/agents");
  const isNewAgentRoute = location.pathname === "/new-agent";

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
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
            {(isAgentsRoute || isNewAgentRoute) && (
              <>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  {agentId ? (
                    <BreadcrumbLink asChild>
                      <Link to="/agents">Agents</Link>
                    </BreadcrumbLink>
                  ) : isNewAgentRoute ? (
                    <BreadcrumbLink asChild>
                      <Link to="/agents">Agents</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Agents</BreadcrumbPage>
                  )}
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
            {agentId && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[150px] truncate sm:max-w-[200px]">
                    {agentId}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {agentId && (
        <div className="ml-auto flex items-center gap-3">
          <Button variant={isChatRoute ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="/agents/$agentId" params={{ agentId }}>
              Web
            </Link>
          </Button>
          <Button variant={isPtyRoute ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="/agents/$agentId/pty" params={{ agentId }}>
              Terminal
            </Link>
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <div className="flex items-center gap-2">
            <Switch id="raw-mode" checked={rawMode} onCheckedChange={setRawMode} />
            <Label htmlFor="raw-mode" className="text-sm text-muted-foreground cursor-pointer">
              Raw
              {rawEventsCount > 0 && (
                <span className="ml-1 text-muted-foreground/60">({rawEventsCount})</span>
              )}
            </Label>
          </div>
        </div>
      )}
    </header>
  );
}
