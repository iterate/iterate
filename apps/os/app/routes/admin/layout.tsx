import { createFileRoute, Link, notFound, Outlet, useLocation } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Shield, MessageSquare, Info, ArrowLeft, Database, Building2, Server } from "lucide-react";
import { useTRPC } from "../../lib/trpc.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "../../components/ui/sidebar.tsx";
import { authenticatedServerFn } from "../../lib/auth-middleware.ts";

const assertIsAdmin = authenticatedServerFn.handler(async ({ context }) => {
  const session = context.variables.session;
  if (session?.user.role !== "admin") throw notFound();
});

const adminLinks = [
  { title: "Session Info", icon: Info, path: "/admin/session-info" },
  { title: "Installations", icon: Building2, path: "/admin/installations" },
  { title: "Test Slack Notification", icon: MessageSquare, path: "/admin/slack-notification" },
  { title: "Database Tools", icon: Database, path: "/admin/db-tools" },
  { title: "tRPC Tools", icon: Server, path: "/admin/trpc-tools" },
];

export const Route = createFileRoute("/_auth.layout/admin")({
  component: AdminLayout,
  loader: () => assertIsAdmin(),
});

function AdminLayout() {
  const location = useLocation();
  const trpc = useTRPC();
  const { data: installations } = useSuspenseQuery(trpc.installation.list.queryOptions());

  // Get the first installation if available, otherwise show a message
  const hasInstallations = installations && installations.length > 0;
  const dashboardLink = hasInstallations
    ? `/${installations[0].organizationId}/${installations[0].id}`
    : "/";

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <Sidebar className="border-r">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <Link to="/admin">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary">
                      <Shield className="size-4 text-primary-foreground" />
                    </div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate font-medium">Admin Tools</span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Admin</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminLinks.map((link) => (
                    <SidebarMenuItem key={link.path}>
                      <SidebarMenuButton asChild isActive={location.pathname === link.path}>
                        <Link to={link.path}>
                          <link.icon className="size-4" />
                          <span>{link.title}</span>
                        </Link>
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
                <SidebarMenuButton asChild>
                  <Link to={dashboardLink}>
                    <ArrowLeft className="size-4" />
                    <span>Back to Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            {/* TODO Breadcrumbs */}
          </header>

          <main className="flex flex-1 flex-col gap-4 p-6 max-w-5xl">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
