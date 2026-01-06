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
    projects: Array<{
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
  currentProject?: {
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

export function Sidebar({ organizations, currentOrg, currentProject, user }: SidebarProps) {
  const params = useParams({ strict: false });
  const projectSlug = params.projectSlug as string | undefined;

  const org = currentOrg || organizations[0];
  const projects = organizations.find((o) => o.slug === org?.slug)?.projects || [];
  const project = currentProject || projects[0];

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

      {/* Project Selector */}
      {org && (
        <div className="p-4 border-b">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <div className="flex items-center gap-2">
                  <Box className="h-4 w-4" />
                  <span className="truncate">{project?.name || "Select Project"}</span>
                </div>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {projects.map((proj) => (
                <DropdownMenuItem key={proj.id} asChild>
                  <Link
                    to="/$organizationSlug/$projectSlug"
                    params={{ organizationSlug: org.slug, projectSlug: proj.slug }}
                  >
                    {proj.name}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {org && project && (
          <Link
            to="/$organizationSlug/$projectSlug"
            params={{ organizationSlug: org.slug, projectSlug: project.slug }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
              projectSlug === project.slug && "bg-accent",
            )}
          >
            <Box className="h-4 w-4" />
            Machines
          </Link>
        )}
        {org && project && (
          <Link
            to="/$organizationSlug/$projectSlug/connectors"
            params={{ organizationSlug: org.slug, projectSlug: project.slug }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
            )}
          >
            <Plug className="h-4 w-4" />
            Connectors
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
            <DropdownMenuItem asChild>
              <Link to="/user/settings">
                <Settings className="h-4 w-4 mr-2" />
                User settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
