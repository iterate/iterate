import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Building2,
  Settings,
  Users,
  Plug,
  Box,
  ChevronDown,
  Plus,
  LogOut,
} from "lucide-react";
import { cn } from "../lib/cn.ts";
import { signOut } from "../lib/auth-client.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

interface SidebarProps {
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    instances: Array<{
      id: string;
      name: string;
      slug: string;
    }>;
  }>;
  currentOrg?: {
    id: string;
    name: string;
    slug: string;
  };
  currentInstance?: {
    id: string;
    name: string;
    slug: string;
  };
  user: {
    name: string;
    email: string;
    image?: string | null;
  };
}

export function Sidebar({ organizations, currentOrg, currentInstance, user }: SidebarProps) {
  const params = useParams({ strict: false });
  const instanceSlug = params.instanceSlug as string | undefined;

  const org = currentOrg || organizations[0];
  const instances = organizations.find((o) => o.slug === org?.slug)?.instances || [];
  const instance = currentInstance || instances[0];

  return (
    <div className="flex h-full w-64 flex-col border-r bg-muted/10">
      {/* Organization Selector */}
      <div className="p-4 border-b">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                <span className="truncate">{org?.name || "Select Organization"}</span>
              </div>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            {organizations.map((organization) => (
              <DropdownMenuItem key={organization.id} asChild>
                <Link to="/$organizationSlug" params={{ organizationSlug: organization.slug }}>
                  {organization.name}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/new-organization">
                <Plus className="h-4 w-4 mr-2" />
                New Organization
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Instance Selector */}
      {org && (
        <div className="p-4 border-b">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <div className="flex items-center gap-2">
                  <Box className="h-4 w-4" />
                  <span className="truncate">{instance?.name || "Select Instance"}</span>
                </div>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {instances.map((inst) => (
                <DropdownMenuItem key={inst.id} asChild>
                  <Link
                    to="/$organizationSlug/$instanceSlug"
                    params={{ organizationSlug: org.slug, instanceSlug: inst.slug }}
                  >
                    {inst.name}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {org && instance && (
          <Link
            to="/$organizationSlug/$instanceSlug"
            params={{ organizationSlug: org.slug, instanceSlug: instance.slug }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
              instanceSlug === instance.slug && "bg-accent",
            )}
          >
            <Box className="h-4 w-4" />
            Machines
          </Link>
        )}
        {org && (
          <>
            <Link
              to="/$organizationSlug/settings"
              params={{ organizationSlug: org.slug }}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
              )}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
            <Link
              to="/$organizationSlug/team"
              params={{ organizationSlug: org.slug }}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
              )}
            >
              <Users className="h-4 w-4" />
              Team
            </Link>
            <Link
              to="/$organizationSlug/connectors"
              params={{ organizationSlug: org.slug }}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
              )}
            >
              <Plug className="h-4 w-4" />
              Connectors
            </Link>
          </>
        )}
      </nav>

      {/* User Menu */}
      <div className="p-4 border-t">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-start">
              <div className="flex items-center gap-2">
                {user.image ? (
                  <img src={user.image} alt={user.name} className="h-6 w-6 rounded-full" />
                ) : (
                  <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs">
                    {user.name[0]}
                  </div>
                )}
                <div className="flex flex-col items-start">
                  <span className="text-sm font-medium truncate">{user.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                </div>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <DropdownMenuItem
              onClick={() => {
                signOut().then(() => {
                  window.location.href = "/login";
                });
              }}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
