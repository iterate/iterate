import { Link, useLocation } from "react-router";
import {
  Home as HomeIcon,
  Settings,
  Users,
  ChevronDown,
  Bot,
  Zap,
  FileText,
  LogOut,
  User,
  CreditCard,
} from "lucide-react";
import { authClient } from "../lib/auth-client";

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
} from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

const navigation = [
  {
    title: "Platform",
    items: [
      { title: "Home", icon: HomeIcon, path: "/" },
      { title: "Integrations", icon: Settings, path: "/integrations" },
      { title: "Manage estate", icon: FileText, path: "/estate" },
    ],
  },
  {
    title: "Agents",
    items: [
      { title: "Manage agents", icon: Users, path: "/agents" },
      { title: "Start Slack Agent", icon: Bot, path: "/slack-agent" },
    ],
  },
];

function UserSwitcher() {
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-full justify-start gap-2 px-2 py-1.5 h-auto">
          <Avatar className="size-8">
            <AvatarImage src="" />
            <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white font-medium">
              NB
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 text-left">
            <div className="font-medium">Nick Blow</div>
            <div className="text-xs text-muted-foreground">nickblow@nustom.com</div>
          </div>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" side="top" align="start">
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <User className="mr-2 h-4 w-4" />
          <span>Profile</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CreditCard className="mr-2 h-4 w-4" />
          <span>Billing</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings className="mr-2 h-4 w-4" />
          <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation();

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <Sidebar className="border-r">
          <SidebarHeader className="border-b px-6 py-4">
            <div className="flex items-center gap-2">
              <img src="/logo.svg" alt="Iterate" className="size-8 text-white" />
              <span className="font-semibold text-lg">Iterate</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">Autopilot engaged</div>
          </SidebarHeader>

          <SidebarContent className="px-4 py-4">
            {navigation.map((section) => (
              <SidebarGroup key={section.title}>
                <SidebarGroupLabel className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  {section.title}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          asChild
                          isActive={location.pathname === item.path}
                          className="w-full justify-start gap-3 px-3 py-2 rounded-lg"
                        >
                          <Link to={item.path}>
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

          <SidebarFooter className="border-t p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="size-2 rounded-full bg-green-500"></div>
              <span className="text-sm text-muted-foreground">Connected</span>
            </div>
            <UserSwitcher />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex-1">
          <header className="flex h-16 items-center gap-4 border-b px-6">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-xl font-semibold">Platform</h1>
            </div>
          </header>

          <main className="flex-1">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
