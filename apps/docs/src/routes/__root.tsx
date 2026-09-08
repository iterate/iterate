import { useEffect, type ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@iterate-com/ui/components/sidebar";
import { TooltipProvider } from "@iterate-com/ui/components/tooltip";
import appCss from "../styles.css?url";
import { startBrowserProjectSessionKeepalive } from "../lib/project-session.ts";
import { getAppShellContext } from "../lib/sidebar-state.ts";
import { AppSidebar } from "../components/app-sidebar.tsx";

export const Route = createRootRoute({
  loader: async () => {
    const shell = await getAppShellContext();
    return { sidebarDefaultOpen: shell.defaultOpen };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Docs" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { sidebarDefaultOpen } = Route.useLoaderData();
  // The project-host session cookie lives 15 minutes; renewing it while
  // the tab is open is what keeps the app signed in past that.
  useEffect(() => startBrowserProjectSessionKeepalive(), []);
  return (
    <RootDocument>
      <TooltipProvider delay={0}>
        <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
          <AppSidebar />
          {/* Mobile scrolls the inset (the page stacks editor + comments taller
              than the viewport); only lg pins the height, matching the doc
              page's own lg:h-svh / lg:overflow-hidden split. */}
          <SidebarInset className="min-w-0 overflow-auto lg:overflow-hidden">
            <Outlet />
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
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
