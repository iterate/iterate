import { Link } from "@tanstack/react-router";
import { ChevronsUpDown, Plus } from "lucide-react";
import { getEnvLogo } from "../lib/env-logo.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar.tsx";

interface Organization {
  id: string;
  name: string;
  slug: string;
  role?: string;
}

interface OrgSwitcherProps {
  organizations: Organization[];
  currentOrg: Organization;
}

export function OrgSwitcher({ organizations, currentOrg }: OrgSwitcherProps) {
  return (
    <SidebarMenu data-component="OrgSwitcher">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg">
                <img src={getEnvLogo()} alt="𝑖" className="size-8" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">iterate</span>
                <span className="truncate text-xs">{currentOrg.name}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} asChild className="gap-2 p-2">
                <Link to="/orgs/$organizationSlug/settings" params={{ organizationSlug: org.slug }}>
                  <div className="flex size-6 items-center justify-center rounded-sm border">
                    <span className="text-xs font-semibold">
                      {org.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium">{org.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">
                      {org.role || "Member"}
                    </span>
                  </div>
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 p-2">
              <Link to="/new-organization">
                <div className="flex size-6 items-center justify-center rounded-md border border-dashed">
                  <Plus className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">Add organization</div>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
