import { Link, useLocation, useParams } from "react-router";
import {
  Home as HomeIcon,
  Settings,
  Github,
  LogOut,
  Building2,
  Check,
  ChevronsUpDown,
  Sun,
  Moon,
  Monitor,
  Shield,
  UserCog,
  CreditCard,
  User,
  Bug,
  Puzzle,
} from "lucide-react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useOrganizationId } from "../hooks/use-estate.ts";
import { useOrganizationWebSocket } from "../hooks/use-websocket.ts";
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
} from "../components/ui/sidebar.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar.tsx";
import { Badge } from "../components/ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { useImpersonation } from "./impersonate.tsx";
import { OrganizationSwitcher } from "./organization-switcher.tsx";

const estateNavigation: NavigationItem[] = [
  { title: "Home", icon: HomeIcon, path: "" },
  { title: "Git repository", icon: Github, path: "repo" },
  { title: "Connectors", icon: Puzzle, path: "integrations" },
];

const organizationNavigation: NavigationItem[] = [
  { title: "Settings", icon: Settings, path: "settings" },
  { title: "Members", icon: UserCog, path: "team" },
  { title: "Billing", icon: CreditCard, path: "billing-portal", external: true },
];

interface Estate {
  id: string;
  name: string;
  organizationName: string;
  organizationId: string;
}

interface NavigationItem {
  title: string;
  icon: React.ElementType;
  path: string;
  external?: boolean;
}

function BillingPortalLink({ item }: { item: NavigationItem }) {
  const organizationId = useOrganizationId();
  const trpc = useTRPC();

  const createBillingSession = useMutation(
    trpc.stripe.createBillingPortalSession.mutationOptions({
      onSuccess: (data) => {
        window.location.href = data.url;
      },
    }),
  );

  const handleClick = () => {
    createBillingSession.mutate({ organizationId });
  };

  return (
    <SidebarMenuButton onClick={handleClick} disabled={createBillingSession.isPending}>
      <item.icon className="size-4" />
      <span>{item.title}</span>
    </SidebarMenuButton>
  );
}

function UserSwitcher() {
  const trpc = useTRPC();
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());
  const impersonation = useImpersonation();

  const handleLogout = async () => {
    try {
      console.log("🚪 Logging out...");
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            // Redirect to login page after successful logout
            window.location.href = "/login";
          },
        },
      });

      console.log("✅ Logout successful!");
    } catch (error) {
      console.error("❌ Logout error:", error);
    }
  };

  // Generate initials from name
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const tooltipContent = impersonation.impersonatedBy ? `Impersonating ${user.email}` : undefined;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className={`data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground ${
                    impersonation.impersonatedBy ? "border-2 border-destructive" : ""
                  }`}
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user.image || ""} alt={user.name} />
                    <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {tooltipContent && <TooltipContent side="right">{tooltipContent}</TooltipContent>}
          </Tooltip>
          <DropdownMenuContent className="w-56" side="top" align="start">
            {impersonation.isAdmin && (
              <DropdownMenuItem onClick={() => impersonation.impersonate.mutate()}>
                Impersonate another user
              </DropdownMenuItem>
            )}
            {impersonation.impersonatedBy && (
              <DropdownMenuItem onClick={() => impersonation.unimpersonate.mutate()}>
                Stop impersonating
              </DropdownMenuItem>
            )}
            {(impersonation.isAdmin || impersonation.impersonatedBy) && <DropdownMenuSeparator />}
            <DropdownMenuItem asChild>
              <Link to="/user-settings">
                <User className="mr-2 h-4 w-4" />
                <span>User Settings</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  const themes = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  const currentTheme = themes.find((t) => t.value === theme) || themes[2];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <currentTheme.icon className="size-4" />
              <span className="truncate">Theme</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48" side="top" align="start">
            <DropdownMenuLabel>Choose theme</DropdownMenuLabel>
            {themes.map((themeOption) => (
              <DropdownMenuItem
                key={themeOption.value}
                onClick={() => setTheme(themeOption.value)}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <themeOption.icon className="size-4" />
                  <span>{themeOption.label}</span>
                </div>
                {theme === themeOption.value && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation();
  const params = useParams();
  const organizationId = useOrganizationId();
  const currentEstateId = params.estateId;
  const trpc = useTRPC();
  const { data: estates } = useSuspenseQuery(trpc.estates.list.queryOptions({ organizationId }));
  const { data: impersonationInfo } = useSuspenseQuery(trpc.admin.impersonationInfo.queryOptions());
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  // Only connect websocket if we're in an estate context
  const _ws = useOrganizationWebSocket(organizationId, currentEstateId || "");

  const getEstateUrl = (estateId: string, path: string) => {
    return `/${organizationId}/${estateId}${path ? `/${path}` : ""}`;
  };

  const getOrgUrl = (path: string) => {
    return `/${organizationId}/${path}`;
  };

  const isPathActive = (url: string) => {
    // Exact match for paths
    if (location.pathname === url) return true;
    // For home paths (ending with estateId), check if pathname ends with the estateId followed by optional slash
    if (url.endsWith(`/${currentEstateId}`) || url.endsWith(`/${currentEstateId}/`)) {
      return location.pathname === url || location.pathname === `${url}/`;
    }
    return false;
  };

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <Sidebar className="border-r">
          <SidebarHeader>
            <OrganizationSwitcher />
          </SidebarHeader>
          <SidebarContent>
            {/* Estate Navigation - One section per estate */}
            {estates?.map((estate: Estate) => (
              <SidebarGroup key={estate.id}>
                {/* Only show estate label if there are multiple estates */}
                {estates.length > 1 && (
                  <SidebarGroupLabel className="flex items-center gap-2">
                    <Building2 className="size-3" />
                    {estate.name}
                  </SidebarGroupLabel>
                )}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {estateNavigation.map((item) => {
                      const url = getEstateUrl(estate.id, item.path);
                      return (
                        <SidebarMenuItem key={item.title}>
                          <SidebarMenuButton asChild isActive={isPathActive(url)}>
                            <Link to={url}>
                              <item.icon className="size-4" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}

            {/* Organization Navigation */}
            <SidebarGroup>
              <SidebarGroupLabel>Organization</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {organizationNavigation.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      {item.external ? (
                        <BillingPortalLink item={item} />
                      ) : (
                        <SidebarMenuButton asChild isActive={isPathActive(getOrgUrl(item.path))}>
                          <Link to={getOrgUrl(item.path)}>
                            <item.icon className="size-4" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* Admin Navigation */}
            {impersonationInfo?.isAdmin && (
              <SidebarGroup>
                <SidebarGroupLabel>Admin</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.pathname.startsWith("/admin")}>
                        <Link to="/admin">
                          <Shield className="size-4" />
                          <span>Admin Tools</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>

          <SidebarFooter>
            {/* Connection indicator temporarily disabled until fixed */}
            {/**
             * {!ws.isConnected && (
             *   <div className="flex items-center gap-2 mb-3 px-3">
             *     <div className={`size-2 rounded-full bg-orange-500`}></div>
             *     <span className="text-sm text-muted-foreground">Websocket connecting...</span>
             *   </div>
             * )}
             */}
            {user.debugMode && (
              <Badge
                variant="secondary"
                className="text-xs bg-muted text-muted-foreground border-muted-foreground/20"
              >
                <Bug className="mr-1 h-3 w-3" />
                DEBUG MODE
              </Badge>
            )}
            <ThemeSwitcher />
            <UserSwitcher />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            {/* TODO Breadcrumbs */}
          </header>

          <main className="flex flex-1 flex-col gap-4 p-6 max-w-5xl">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
