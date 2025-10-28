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
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { fromString } from "typeid-js";
import { toast } from "sonner";
import { authClient } from "../lib/auth-client.ts";
import { trpcClient, useTRPC } from "../lib/trpc.ts";
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
import { useDebounce } from "../hooks/use-debounced.ts";
import { cn } from "../lib/utils.ts";
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

interface ImpersonationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (type: "email" | "user_id" | "estate_id", value: string) => void;
  isPending?: boolean;
}

function ImpersonationDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: ImpersonationDialogProps) {
  const [value, setValue] = useState("");
  const [type, setType] = useState<"email" | "user_id" | "estate_id">("email");

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
    if (type === "estate_id") {
      try {
        fromString(value, "est");
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
              setType(value as "email" | "user_id" | "estate_id");
              setValue("");
            }}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="email">By Email</TabsTrigger>
              <TabsTrigger value="user_id">By User ID</TabsTrigger>
              <TabsTrigger value="estate_id">By Estate ID</TabsTrigger>
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
            <TabsContent value="estate_id" className="mt-4">
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="est_xxxxxxxxxxxxxxxxxxxxxxxx"
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

async function resolveImpersonation(type: "email" | "user_id" | "estate_id", value: string) {
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
  if (type === "estate_id") {
    const estate = await trpcClient.admin.getEstateOwner.query({ estateId: value });
    if (!estate) {
      throw new Error("Estate not found");
    }
    return estate.userId;
  }
  throw new Error("Invalid type");
}

function UserSwitcher() {
  const [impersonationDialogOpen, setImpersonationDialogOpen] = useState(false);
  const trpc = useTRPC();
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());
  const { data: impersonationInfo } = useSuspenseQuery(trpc.admin.impersonationInfo.queryOptions());

  const startImpersonation = useMutation({
    mutationFn: async (params: { type: "email" | "user_id" | "estate_id"; value: string }) => {
      const userId = await resolveImpersonation(params.type, params.value);
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

  const handleImpersonationSubmit = (type: "email" | "user_id" | "estate_id", value: string) => {
    startImpersonation.mutate({ type, value });
  };

  const handleLogout = async () => {
    try {
      console.log("🚪 Logging out...");
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
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

  const tooltipContent = impersonationInfo.impersonatedBy
    ? `Impersonating ${user.email}`
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
                    impersonationInfo.impersonatedBy ? "border-2 border-destructive" : ""
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
            {impersonationInfo.isAdmin && (
              <DropdownMenuItem onClick={() => setImpersonationDialogOpen(true)}>
                Impersonate another user
              </DropdownMenuItem>
            )}
            {impersonationInfo.impersonatedBy && (
              <DropdownMenuItem
                onClick={() => stopImpersonation.mutate()}
                disabled={stopImpersonation.isPending}
              >
                {stopImpersonation.isPending ? "Stopping..." : "Stop impersonating"}
              </DropdownMenuItem>
            )}
            {(impersonationInfo.isAdmin || impersonationInfo.impersonatedBy) && (
              <DropdownMenuSeparator />
            )}
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
      {impersonationInfo.isAdmin && (
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

          <main className="flex flex-1 flex-col gap-4 p-6 max-w-6xl">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
