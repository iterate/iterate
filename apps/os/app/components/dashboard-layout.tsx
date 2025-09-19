import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Home as HomeIcon,
  Settings,
  Users,
  FileText,
  LogOut,
  Building2,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import { authClient } from "../lib/auth-client.ts";
import { trpc } from "../lib/trpc.ts";
import { setSelectedEstate } from "../lib/estate-cookie.ts";
import { useEstateId, useEstateUrl } from "../hooks/use-estate.ts";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";

const navigation = [
  {
    title: "Platform",
    items: [
      { title: "Home", icon: HomeIcon, path: "" },
      { title: "Integrations", icon: Settings, path: "integrations" },
      { title: "Manage estate", icon: FileText, path: "estate" },
    ],
  },
  {
    title: "Agents",
    items: [{ title: "Manage agents", icon: Users, path: "agents" }],
  },
];

interface Estate {
  id: string;
  name: string;
  organizationName: string;
  organizationId: string;
}

function UserSwitcher() {
  const [user] = trpc.user.me.useSuspenseQuery();
  const [estates] = trpc.estates.list.useSuspenseQuery();
  const navigate = useNavigate();
  const params = useParams();
  const currentEstateId = params.estateId;

  const currentEstate = estates?.find((e: Estate) => e.id === currentEstateId) || null;

  const handleLogout = async () => {
    try {
      console.log("🚪 Logging out...");
      const result = await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            // Redirect to login page after successful logout
            window.location.href = "/login";
          },
        },
      });

      if (result.error) {
        console.error("❌ Logout failed:", result.error);
      } else {
        console.log("✅ Logout successful!");
      }
    } catch (error) {
      console.error("❌ Logout error:", error);
    }
  };

  const handleEstateSwitch = (estate: Estate) => {
    // Save the new selection to cookie
    setSelectedEstate(estate.organizationId, estate.id);

    // Get the current path within the estate
    const currentPath = window.location.pathname;
    const pathParts = currentPath.split("/").slice(3); // Remove org/estate parts
    const subPath = pathParts.join("/");

    // Navigate to the same page in the new estate
    navigate(`/${estate.organizationId}/${estate.id}${subPath ? `/${subPath}` : ""}`);
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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
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
          <DropdownMenuContent className="w-56" side="top" align="start">
            {currentEstate && (
              <>
                <DropdownMenuLabel>Switch Estate</DropdownMenuLabel>
                {estates?.map((estate: Estate) => (
                  <DropdownMenuItem
                    key={estate.id}
                    onClick={() => handleEstateSwitch(estate)}
                    className="flex items-center justify-between"
                    disabled={currentEstateId === estate.id}
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4" />
                      <span>{estate.name}</span>
                    </div>
                    {currentEstateId === estate.id && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
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

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation();
  const getEstateUrl = useEstateUrl();
  const estateId = useEstateId();
  const { isConnected } = useOrganizationWebSocket();
  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <Sidebar className="border-r">
          <SidebarContent>
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="lg" asChild>
                    <a href="#">
                      <div className="bg-black flex aspect-square size-8 items-center justify-center rounded-lg">
                        <img src="/logo.svg" alt="𝑖" className="size-6 text-white" />
                      </div>
                      <div className="grid flex-1 text-left leading-tight">
                        <span className="truncate font-medium">iterate</span>
                      </div>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>

            {navigation.map((section) => (
              <SidebarGroup key={section.title}>
                <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          asChild
                          isActive={
                            (item.path && location.pathname.endsWith(item.path)) ||
                            (item.path === "" && location.pathname.endsWith(`/${estateId}/`))
                          }
                        >
                          <Link to={getEstateUrl(item.path)}>
                            <item.icon className="size-4" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter>
            {!isConnected && (
              <div className="flex items-center gap-2 mb-3 px-3">
                <div className={`size-2 rounded-full bg-orange-500`}></div>
                <span className="text-sm text-muted-foreground">Convex connecting...</span>
              </div>
            )}
            <UserSwitcher />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-16 items-center gap-4 border-b px-6">
            <SidebarTrigger />
            {/* TODO Breadcrumbs */}
          </header>

          <main>{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
