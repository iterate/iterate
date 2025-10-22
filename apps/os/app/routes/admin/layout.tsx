import { Link, Outlet, useLocation } from "react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Shield,
  MessageSquare,
  Info,
  ArrowLeft,
  AlertCircle,
  Database,
  Building2,
  Server,
  Route as RouteIcon,
  Beaker,
} from "lucide-react";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { authClient } from "../../lib/auth-client.ts";
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

const adminLinks = [
  { title: "Session Info", icon: Info, path: "/admin/session-info" },
  { title: "Estates", icon: Building2, path: "/admin/estates" },
  { title: "Slack Channel Routing", icon: RouteIcon, path: "/admin/slack-channel-routing" },
  { title: "Trial Channel Setup", icon: Beaker, path: "/admin/trial-channel-setup" },
  { title: "Test Slack Notification", icon: MessageSquare, path: "/admin/slack-notification" },
  { title: "Database Tools", icon: Database, path: "/admin/db-tools" },
  { title: "tRPC Tools", icon: Server, path: "/admin/trpc-tools" },
];

export default function AdminLayout() {
  const location = useLocation();
  const trpc = useTRPC();
  const { data: impersonationInfo } = useSuspenseQuery(trpc.admin.impersonationInfo.queryOptions());
  const { data: estates } = useSuspenseQuery(trpc.estates.list.queryOptions());

  // Show admin-specific access denied for non-admins
  if (!impersonationInfo?.isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md w-full px-6 py-8">
          <div className="text-center">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/20 mb-4">
              <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              Admin Access Required
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              You need administrator privileges to access this area.
            </p>
            <div className="space-y-3">
              <Link to="/">
                <Button variant="default" className="w-full">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Dashboard
                </Button>
              </Link>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  authClient.signOut({
                    fetchOptions: {
                      onSuccess: () => {
                        window.location.href = "/login";
                      },
                    },
                  });
                }}
              >
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Get the first estate if available, otherwise show a message
  const hasEstates = estates && estates.length > 0;
  const dashboardLink = hasEstates ? `/${estates[0].organizationId}/${estates[0].id}` : "/";

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
