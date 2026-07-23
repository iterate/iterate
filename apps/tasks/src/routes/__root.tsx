import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { getAppShellContext } from "../lib/sidebar-state.ts";
import { ProjectLabelContext } from "../lib/project-label.ts";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar.tsx";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { AppSidebar } from "../components/app-sidebar.tsx";

export const Route = createRootRoute({
  loader: async () => {
    const shell = await getAppShellContext();
    return { sidebarDefaultOpen: shell.defaultOpen, projectLabel: shell.projectLabel };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "tasks" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

/**
 * The whole app is a sidebar (repos → checkouts, from the project's index
 * DO) plus whatever page is open — deliberately no header; each page owns
 * its own top strip (the board's filter bar).
 */
function RootComponent() {
  const { sidebarDefaultOpen, projectLabel } = Route.useLoaderData();
  return (
    <RootDocument>
      <ProjectLabelContext.Provider value={projectLabel}>
        <TooltipProvider delay={0}>
          <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
            <AppSidebar />
            <SidebarInset className="min-w-0 overflow-hidden">
              <Outlet />
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </ProjectLabelContext.Provider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
