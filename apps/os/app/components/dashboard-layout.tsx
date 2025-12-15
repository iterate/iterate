import { ClientOnly, getRouteApi, Link, useLocation, useParams } from "@tanstack/react-router";
import {
  Home as HomeIcon,
  Settings,
  Github,
  LogOut,
  Building2,
  ChevronsUpDown,
  Shield,
  UserCog,
  CreditCard,
  User,
  Bug,
  Puzzle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fromString } from "typeid-js";
import { toast } from "sonner";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC, useTRPCClient, type TRPCClient } from "../lib/trpc.ts";
import { useOrganizationId } from "../hooks/use-installation.ts";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { useDebounce } from "../hooks/use-debounced.ts";
import { cn } from "../lib/utils.ts";
import { useSessionUser } from "../hooks/use-session-user.ts";
import { OrganizationSwitcher } from "./organization-switcher.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { AutoComplete } from "./autocomplete.tsx";
import ThemeSwitcher from "./theme-switcher.tsx";

const installationNavigation: NavigationItem[] = [
  { title: "Home", icon: HomeIcon, path: "" },
  { title: "Git repository", icon: Github, path: "repo" },
  { title: "Connectors", icon: Puzzle, path: "integrations" },
];

const organizationNavigation: NavigationItem[] = [
  { title: "Settings", icon: Settings, path: "settings" },
  { title: "Members", icon: UserCog, path: "team" },
  { title: "Billing", icon: CreditCard, path: "billing-portal", external: true },
];

interface Installation {
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

interface ImpersonationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (type: "email" | "user_id" | "installation_id", value: string) => void;
  isPending?: boolean;
}

function ImpersonationDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: ImpersonationDialogProps) {
  const [value, setValue] = useState("");
  const [type, setType] = useState<"email" | "user_id" | "installation_id">("email");

  const trpc = useTRPC();
  const debouncedValue = useDebounce(value, 500);

  const emailUsersQuery = useQuery(
    trpc.admin.searchUsersByEmail.queryOptions(
      {
        searchEmail: debouncedValue,
      },
      {
        enabled: debouncedValue.length > 0 && type === "email",
        initialData: [],
      },
    ),
  );

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(type, value.trim());
  };

  const isValid = useMemo(() => {
    if (type === "email") {
      return emailUsersQuery.data?.some((user) => user.email === value);
    }
    if (type === "user_id") {
      try {
        fromString(value, "usr");
        return true;
      } catch {
        return false;
      }
    }
    if (type === "installation_id") {
      try {
        fromString(value, "inst");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, [value, type, emailUsersQuery.data]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setValue("");
      setType("email");
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Impersonate another user</DialogTitle>
          <DialogDescription>How you want to identify the user to impersonate</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Tabs
            defaultValue="email"
            value={type}
            onValueChange={(value) => {
              setType(value as "email" | "user_id" | "installation_id");
              setValue("");
            }}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="email">By Email</TabsTrigger>
              <TabsTrigger value="user_id">By User ID</TabsTrigger>
              <TabsTrigger value="installation_id">By Installation ID</TabsTrigger>
            </TabsList>
            <TabsContent value="email" className="mt-4">
              <div className="w-full">
                <AutoComplete
                  items={emailUsersQuery.data?.map((user) => ({
                    value: user.email,
                    label: user.email,
                  }))}
                  placeholder="Start typing user's email"
                  emptyMessage="No users found"
                  isLoading={emailUsersQuery.isPending}
                  selectedValue={value}
                  onSelectedValueChange={(value) => setValue(value)}
                  searchValue={value}
                  onSearchValueChange={(value) => setValue(value)}
                />
              </div>
            </TabsContent>
            <TabsContent value="user_id" className="mt-4">
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="usr_xxxxxxxxxxxxxxxxxxxxxxxx"
                className={cn({
                  "border-destructive": value.length > 0 && !isValid,
                })}
                aria-invalid={value.length > 0 && !isValid}
                disabled={isPending}
              />
            </TabsContent>
            <TabsContent value="installation_id" className="mt-4">
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="inst_xxxxxxxxxxxxxxxxxxxxxxxx"
                className={cn({
                  "border-destructive": value.length > 0 && !isValid,
                })}
                aria-invalid={value.length > 0 && !isValid}
                disabled={isPending}
              />
            </TabsContent>
          </Tabs>
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!isValid || isPending}>
              {isPending ? "Impersonating..." : "Impersonate"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function resolveImpersonation(
  trpcClient: TRPCClient,
  type: "email" | "user_id" | "installation_id",
  value: string,
) {
  if (type === "email") {
    const user = await trpcClient.admin.findUserByEmail.query({ email: value });
    if (!user) {
      throw new Error("User not found");
    }
    return user.id;
  }
  if (type === "user_id") {
    return value;
  }
  if (type === "installation_id") {
    const installation = await trpcClient.admin.getInstallationOwner.query({
      installationId: value,
    });
    if (!installation) {
      throw new Error("Installation not found");
    }
    return installation.userId;
  }
  throw new Error("Invalid type");
}

function UserSwitcher() {
  const [impersonationDialogOpen, setImpersonationDialogOpen] = useState(false);
  const trpc = useTRPC();
  const user = useSessionUser();
  const impersonationInfoQuery = useQuery(
    trpc.admin.impersonationInfo.queryOptions(void 0, {
      initialData: {},
      staleTime: 1000 * 60 * 5,
    }),
  );
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const startImpersonation = useMutation({
    mutationFn: async (params: {
      type: "email" | "user_id" | "installation_id";
      value: string;
    }) => {
      const userId = await resolveImpersonation(trpcClient, params.type, params.value);
      await authClient.admin.impersonateUser({ userId });
    },
    onSuccess: () => {
      window.location.reload();
    },
    onError: (error) => {
      toast.error(
        `Failed to impersonate user: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const stopImpersonation = useMutation({
    mutationFn: async () => {
      await authClient.admin.stopImpersonating();
    },
    onSuccess: () => {
      window.location.reload();
    },
    onError: (error) => {
      toast.error(
        `Failed to stop impersonation: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const handleImpersonationSubmit = (
    type: "email" | "user_id" | "installation_id",
    value: string,
  ) => {
    startImpersonation.mutate({ type, value });
  };

  const handleLogout = async () => {
    try {
      console.log("🚪 Logging out...");
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            queryClient.clear();
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

  const tooltipContent = impersonationInfoQuery.data?.impersonatedBy
    ? `Impersonating ${user.email ?? ""}`
    : undefined;

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
                    impersonationInfoQuery.data?.impersonatedBy ? "border-2 border-destructive" : ""
                  }`}
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user.image ?? undefined} alt={user.name} />
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
            {impersonationInfoQuery.data?.isAdmin && (
              <DropdownMenuItem onClick={() => setImpersonationDialogOpen(true)}>
                Impersonate another user
              </DropdownMenuItem>
            )}
            {impersonationInfoQuery.data?.impersonatedBy && (
              <DropdownMenuItem
                onClick={() => stopImpersonation.mutate()}
                disabled={stopImpersonation.isPending}
              >
                {stopImpersonation.isPending ? "Stopping..." : "Stop impersonating"}
              </DropdownMenuItem>
            )}
            {(impersonationInfoQuery.data?.isAdmin ||
              impersonationInfoQuery.data?.impersonatedBy) && <DropdownMenuSeparator />}
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

      {/* Impersonation Dialog */}
      {impersonationInfoQuery.data?.isAdmin && (
        <ImpersonationDialog
          open={impersonationDialogOpen}
          onOpenChange={setImpersonationDialogOpen}
          onSubmit={handleImpersonationSubmit}
          isPending={startImpersonation.isPending}
        />
      )}
    </SidebarMenu>
  );
}

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const orgRoute = getRouteApi("/_auth.layout/$organizationId");

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation();
  const params = useParams({ strict: false });
  const organizationId = useOrganizationId();
  const currentInstallationId = params.installationId;
  const trpc = useTRPC();
  const loaderData = orgRoute.useLoaderData();

  const installationsQuery = useQuery(
    trpc.installation.list.queryOptions(
      { organizationId },
      {
        initialData: () => loaderData?.installations ?? [],
        staleTime: 1000 * 60 * 5,
      },
    ),
  );

  const user = useSessionUser();

  // Only connect websocket if we're in an installation context
  const _ws = useOrganizationWebSocket(
    organizationId,
    currentInstallationId ?? loaderData?.installations[0]?.id ?? "",
  );

  const getInstallationUrl = (installationId: string, path: string) => {
    return `/${organizationId}/${installationId}${path ? `/${path}` : ""}`;
  };

  const getOrgUrl = (path: string) => {
    return `/${organizationId}/${path}`;
  };

  const isPathActive = (url: string) => {
    // Exact match for paths
    if (location.pathname === url) return true;
    // For home paths (ending with installationId), check if pathname ends with the installationId followed by optional slash
    if (url.endsWith(`/${currentInstallationId}`) || url.endsWith(`/${currentInstallationId}/`)) {
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
            {/* Installation Navigation - One section per installation */}
            {installationsQuery.data?.map((installation: Installation) => (
              <SidebarGroup key={installation.id}>
                {/* Only show installation label if there are multiple installations */}
                {installationsQuery.data.length > 1 && (
                  <SidebarGroupLabel className="flex items-center gap-2">
                    <Building2 className="size-3" />
                    {installation.name}
                  </SidebarGroupLabel>
                )}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {installationNavigation.map((item) => {
                      const url = getInstallationUrl(installation.id, item.path);
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
            {user.role === "admin" && (
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
            <ClientOnly>
              <ThemeSwitcher />
            </ClientOnly>
            <UserSwitcher />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            {/* TODO Breadcrumbs */}
          </header>

          <main className="flex flex-1 flex-col gap-4 p-6 max-w-6xl">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
