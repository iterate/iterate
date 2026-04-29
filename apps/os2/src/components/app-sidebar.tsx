import { Link, useMatchRoute } from "@tanstack/react-router";
import { OrganizationSwitcher, UserButton } from "@clerk/tanstack-react-start";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";

const items = [
  { to: "/debug", label: "Debug" },
  { to: "/log-stream", label: "Log Stream" },
  { to: "/projects", label: "Projects" },
  { to: "/codemode", label: "Codemode" },
] as const;

export function AppSidebar() {
  return (
    <SidebarShell header={<AppSidebarOrganization />} footer={<AppSidebarUser />}>
      <AppSidebarNav />
    </SidebarShell>
  );
}

function AppSidebarOrganization() {
  return (
    <div className="px-2">
      <OrganizationSwitcher
        hidePersonal
        afterCreateOrganizationUrl="/"
        afterLeaveOrganizationUrl="/organization"
        afterSelectOrganizationUrl="/"
        appearance={{
          elements: {
            organizationSwitcherTrigger:
              "w-full justify-start rounded-md border border-sidebar-border bg-sidebar-accent px-3 py-2 text-sidebar-accent-foreground shadow-none",
            organizationPreview: "min-w-0",
            organizationPreviewTextContainer: "min-w-0 text-left",
          },
        }}
      />
    </div>
  );
}

function AppSidebarUser() {
  return (
    <div className="flex items-center px-3 py-2">
      <UserButton />
    </div>
  );
}

function AppSidebarNav() {
  const matchRoute = useMatchRoute();

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                render={<Link to={item.to} />}
                isActive={Boolean(matchRoute({ to: item.to, fuzzy: true }))}
              >
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
