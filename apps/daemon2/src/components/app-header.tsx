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

interface AppHeaderProps {
  tmuxSessionName?: string;
}

export function AppHeader({ tmuxSessionName }: AppHeaderProps) {
  const location = useLocation();

  const isTmuxSessionRoute = location.pathname.startsWith("/tmux-sessions");

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
            {isTmuxSessionRoute && (
              <>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  {tmuxSessionName ? (
                    <BreadcrumbLink asChild>
                      <Link to="/">Agents</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Agents</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            )}
            {tmuxSessionName && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[150px] truncate sm:max-w-[200px]">
                    {tmuxSessionName}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
