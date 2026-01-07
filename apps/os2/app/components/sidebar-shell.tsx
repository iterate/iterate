import { type ReactNode } from "react";
import { ClientOnly, Link } from "@tanstack/react-router";
import { Box, ChevronDown, LogOut, Settings } from "lucide-react";
import { signOut } from "../lib/auth-client.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar.tsx";
import { ThemeSwitcher } from "./theme-switcher.tsx";

interface User {
  name: string;
  email: string;
  image?: string | null;
  role?: string;
}

interface SidebarShellProps {
  header: ReactNode;
  children: ReactNode;
  user: User;
}

export function SidebarShell({ header, children, user }: SidebarShellProps) {
  return (
    <Sidebar>
      <SidebarHeader>{header}</SidebarHeader>
      <SidebarContent>{children}</SidebarContent>
      <SidebarFooter>
        <ClientOnly>
          <ThemeSwitcher />
        </ClientOnly>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  {user.image ? (
                    <img src={user.image} alt={user.name} className="h-7 w-7 rounded-full" />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs">
                      {user.name[0]}
                    </div>
                  )}
                  <div className="grid min-w-0 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  </div>
                  <ChevronDown className="ml-auto h-4 w-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" side="right" align="end">
                <DropdownMenuItem asChild>
                  <Link to="/user/settings">
                    <Settings className="mr-2 h-4 w-4" />
                    User settings
                  </Link>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin">
                      <Box className="mr-2 h-4 w-4" />
                      Admin
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    signOut().then(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
