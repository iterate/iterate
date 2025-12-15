import { ChevronsUpDown, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useTRPC } from "../lib/trpc.ts";
import { useSessionUser } from "../hooks/use-session-user.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar.tsx";

const orgRoute = getRouteApi("/_auth.layout/$organizationId");
export function OrganizationSwitcher() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const loaderData = orgRoute.useLoaderData();
  const organizationsQuery = useQuery(
    trpc.organization.list.queryOptions(void 0, {
      initialData: loaderData?.organizations ?? [],
      // Organizations are not likely to change frequently, cache for 5 minutes
      staleTime: 1000 * 60 * 5,
    }),
  );

  const user = useSessionUser();

  // Only show organizations where user is owner or member
  const organizations = organizationsQuery.data.filter(
    (org) => org.role === "owner" || org.role === "member",
  );

  // If there are no organizations, show a prompt to create one
  if (organizations.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" onClick={() => navigate({ to: "/new-organization" })}>
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg border border-dashed">
              <Plus className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">Create Organization</span>
              <span className="truncate text-xs text-muted-foreground">Get started</span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const handleOrganizationSwitch = (organizationId: string) => {
    // Navigate to the organization page (which will redirect to first installation)
    navigate({ to: `/$organizationId`, params: { organizationId } });
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
              <div className="bg-black flex aspect-square size-8 items-center justify-center rounded-lg">
                <img src="/logo.svg" alt="𝑖" className="size-6 text-white" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">iterate</span>
                <span className="truncate text-xs">
                  {loaderData?.organization.name || "Select Organization"}
                </span>
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
              <DropdownMenuItem
                key={org.id}
                onClick={() => handleOrganizationSwitch(org.id)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-sm border">
                  <span className="text-xs font-semibold">{org.name.charAt(0).toUpperCase()}</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-medium">{org.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{org.role}</span>
                </div>
              </DropdownMenuItem>
            ))}
            {user.debugMode && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 p-2"
                  onClick={() => navigate({ to: "/new-organization" })}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border border-dashed">
                    <Plus className="size-4" />
                  </div>
                  <div className="font-medium text-muted-foreground">Add organization</div>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
